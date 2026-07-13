import { PgBoss } from 'pg-boss';
import type { JobWithMetadata } from 'pg-boss';
import { z } from 'zod';
import { createLogger, loadWorkerEnv } from '@zendori/core';
import { writeHeartbeat } from './heartbeat.js';
import { toErrorInfo } from './db.js';
import { handlePipelineFailure, processMessage } from './pipeline/process-message.js';
import { indexSource, markIndexSourceFailed } from './pipeline/index-source.js';
import {
  INDEX_SOURCE_QUEUE,
  INDEX_SOURCE_RETRY_LIMIT,
  PROCESS_MESSAGE_QUEUE,
  PROCESS_MESSAGE_RETRY_LIMIT,
  startScan,
} from './scan.js';

const logger = createLogger('worker');

const HEARTBEAT_QUEUE = 'worker.heartbeat';

const processMessageJobSchema = z.object({ messageId: z.uuid() });
const indexSourceJobSchema = z.object({ sourceId: z.uuid() });

async function main(): Promise<void> {
  const env = loadWorkerEnv();

  // pg-boss requires a session-mode connection (direct port / session pooler),
  // NOT the transaction pooler — see CLAUDE.md §3.
  const boss = new PgBoss({ connectionString: env.DATABASE_URL_SESSION });
  boss.on('error', (error: unknown) => logger.error({ err: toErrorInfo(error) }, 'pg-boss error'));

  await boss.start();

  // --- heartbeat (Docker healthcheck) ---------------------------------------
  await boss.createQueue(HEARTBEAT_QUEUE);
  await boss.schedule(HEARTBEAT_QUEUE, '* * * * *');
  await boss.work(HEARTBEAT_QUEUE, async () => {
    await writeHeartbeat();
    logger.debug('heartbeat');
  });

  // --- Phase-4 pipelines -----------------------------------------------------
  // 'singleton' policy: at most one *active* job per singletonKey (the row id),
  // so a redelivered scan never runs the same message/source concurrently. The
  // handlers additionally re-check the row's state as a second idempotency layer.
  await boss.createQueue(PROCESS_MESSAGE_QUEUE, { policy: 'singleton' });
  await boss.createQueue(INDEX_SOURCE_QUEUE, { policy: 'singleton' });

  await boss.work(
    PROCESS_MESSAGE_QUEUE,
    { includeMetadata: true },
    async (jobs: JobWithMetadata<{ messageId: string }>[]) => {
      for (const job of jobs) {
        const { messageId } = processMessageJobSchema.parse(job.data);
        try {
          await processMessage(messageId);
        } catch (err) {
          const isFinal = job.retryCount >= PROCESS_MESSAGE_RETRY_LIMIT;
          logger.error(
            { err: toErrorInfo(err), messageId, retryCount: job.retryCount, final: isFinal },
            'process-message failed'
          );
          if (isFinal) {
            await handlePipelineFailure(messageId, err);
            return; // recorded terminally; do not rethrow
          }
          throw err; // let pg-boss retry
        }
      }
    }
  );

  await boss.work(
    INDEX_SOURCE_QUEUE,
    { includeMetadata: true },
    async (jobs: JobWithMetadata<{ sourceId: string }>[]) => {
      for (const job of jobs) {
        const { sourceId } = indexSourceJobSchema.parse(job.data);
        try {
          await indexSource(sourceId);
        } catch (err) {
          const isFinal = job.retryCount >= INDEX_SOURCE_RETRY_LIMIT;
          logger.error(
            { err: toErrorInfo(err), sourceId, retryCount: job.retryCount, final: isFinal },
            'index-source failed'
          );
          if (isFinal) {
            await markIndexSourceFailed(sourceId);
            return; // recorded terminally; do not rethrow
          }
          throw err; // let pg-boss retry
        }
      }
    }
  );

  const stopScan = startScan(boss, logger);

  // initial heartbeat so the container reports healthy right after boot
  await writeHeartbeat();
  logger.info('worker started');

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    stopScan();
    void boss
      .stop()
      .catch((err: unknown) => logger.error({ err: toErrorInfo(err) }, 'error during pg-boss stop'))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err: toErrorInfo(err) }, 'worker failed to start');
  process.exit(1);
});
