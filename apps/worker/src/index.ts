import { PgBoss } from 'pg-boss';
import type { JobWithMetadata } from 'pg-boss';
import { z } from 'zod';
import { createLogger, loadWorkerEnv } from '@zendori/core';
import { writeHeartbeat } from './heartbeat.js';
import { getServiceClient, toErrorInfo } from './db.js';
import { handlePipelineFailure, processMessage } from './pipeline/process-message.js';
import { indexSource, markIndexSourceFailed } from './pipeline/index-source.js';
import { markHubspotSyncTerminal, syncConversation } from './pipeline/hubspot-sync.js';
import {
  HUBSPOT_SYNC_QUEUE,
  HUBSPOT_SYNC_RETRY_LIMIT,
  INDEX_SOURCE_QUEUE,
  INDEX_SOURCE_RETRY_LIMIT,
  PROCESS_MESSAGE_QUEUE,
  PROCESS_MESSAGE_RETRY_LIMIT,
  startScan,
} from './scan.js';
import { startVoiceDispatch } from './voice/dispatch.js';
import {
  POST_CALL_QUEUE,
  POST_CALL_RETRY_LIMIT,
  markPostCallTerminal,
  processPostCall,
} from './pipeline/post-call.js';
import { FORM_NOTIFY_QUEUE, processFormNotification } from './pipeline/form-notify.js';
import {
  LEARN_DISTILL_QUEUE,
  LEARN_DISTILL_RETRY_LIMIT,
  distillLearnedAnswer,
  markLearnDistillFailed,
} from './pipeline/learn.js';

const logger = createLogger('worker');

const HEARTBEAT_QUEUE = 'worker.heartbeat';

const processMessageJobSchema = z.object({ messageId: z.uuid() });
const indexSourceJobSchema = z.object({ sourceId: z.uuid() });
const hubspotSyncJobSchema = z.object({ conversationId: z.uuid() });
const postCallJobSchema = z.object({ voiceCallId: z.uuid() });
const formNotifyJobSchema = z.object({ notificationId: z.uuid() });
const learnDistillJobSchema = z.object({ learnedAnswerId: z.uuid() });

/**
 * Ensure the queue exists with the 'stately' policy. createQueue does not change
 * the policy of an existing queue and updateQueue cannot set policy (pg-boss
 * v12), so when an earlier worker version created the queue with a different
 * policy we drop and recreate it. Safe: the scan re-derives all work from the
 * source-of-truth DB state every second, so any dropped queued job is
 * re-enqueued (there is a single worker process — §2).
 */
async function ensureQueuePolicy(boss: PgBoss, name: string): Promise<void> {
  await boss.createQueue(name, { policy: 'stately' });
  const existing = await boss.getQueue(name);
  if (existing && existing.policy !== 'stately') {
    await boss.deleteQueue(name);
    await boss.createQueue(name, { policy: 'stately' });
  }
}

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
  // 'stately' policy: at most one job in the created OR active state per
  // singletonKey (the row id). This blocks BOTH a concurrent run and a queued
  // duplicate, so a scan that re-sends the same message/source every second while
  // it is still pending never fans out into multiple LLM pipeline runs. createQueue
  // does NOT change the policy of an already-existing queue, so updateQueue
  // enforces it on queues created by earlier worker versions. The handlers still
  // re-check row state / claim before external side effects (belt and braces).
  await ensureQueuePolicy(boss, PROCESS_MESSAGE_QUEUE);
  await ensureQueuePolicy(boss, INDEX_SOURCE_QUEUE);
  await ensureQueuePolicy(boss, HUBSPOT_SYNC_QUEUE);

  await boss.work(
    PROCESS_MESSAGE_QUEUE,
    // pollingIntervalSeconds 1 (pg-boss default 2, min 0.5): together with the
    // 1 s scan this caps queueing dead time at ~2 s worst case (~1 s average).
    // Only this queue is latency-sensitive; the others keep the 2 s default.
    { includeMetadata: true, pollingIntervalSeconds: 1 },
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

  await boss.work(
    HUBSPOT_SYNC_QUEUE,
    { includeMetadata: true },
    async (jobs: JobWithMetadata<{ conversationId: string }>[]) => {
      for (const job of jobs) {
        const { conversationId } = hubspotSyncJobSchema.parse(job.data);
        try {
          await syncConversation(conversationId);
        } catch (err) {
          const isFinal = job.retryCount >= HUBSPOT_SYNC_RETRY_LIMIT;
          logger.error(
            { err: toErrorInfo(err), conversationId, retryCount: job.retryCount, final: isFinal },
            'hubspot-sync failed'
          );
          if (isFinal) {
            // Stamp synced so the scan stops re-picking; a new request re-arms it.
            await markHubspotSyncTerminal(conversationId);
            return; // recorded terminally; do not rethrow
          }
          throw err; // let pg-boss retry
        }
      }
    }
  );

  // --- Phase-9 voice post-call pipeline ---------------------------------------
  await ensureQueuePolicy(boss, POST_CALL_QUEUE);
  await boss.work(
    POST_CALL_QUEUE,
    { includeMetadata: true },
    async (jobs: JobWithMetadata<{ voiceCallId: string }>[]) => {
      for (const job of jobs) {
        const { voiceCallId } = postCallJobSchema.parse(job.data);
        try {
          await processPostCall(voiceCallId);
        } catch (err) {
          const isFinal = job.retryCount >= POST_CALL_RETRY_LIMIT;
          logger.error(
            { err: toErrorInfo(err), voiceCallId, retryCount: job.retryCount, final: isFinal },
            'voice post-call failed'
          );
          if (isFinal) {
            // Stamp so the scan stops re-enqueuing (no infinite paid LLM loop).
            await markPostCallTerminal(voiceCallId);
            return;
          }
          throw err; // let pg-boss retry
        }
      }
    }
  );

  // --- Phase-10 form-notification forwarding ----------------------------------
  await ensureQueuePolicy(boss, FORM_NOTIFY_QUEUE);
  await boss.work(
    FORM_NOTIFY_QUEUE,
    { includeMetadata: true },
    async (jobs: JobWithMetadata<{ notificationId: string }>[]) => {
      const supabase = getServiceClient();
      for (const job of jobs) {
        const parsed = formNotifyJobSchema.parse(job.data);
        // processFormNotification handles the terminal attempt itself (state
        // 'failed' + internal note) and only rethrows for retryable attempts.
        await processFormNotification(supabase, logger, parsed, job.retryCount);
      }
    }
  );

  // --- learning-loop distillation (0020) --------------------------------------
  await ensureQueuePolicy(boss, LEARN_DISTILL_QUEUE);
  await boss.work(
    LEARN_DISTILL_QUEUE,
    { includeMetadata: true },
    async (jobs: JobWithMetadata<{ learnedAnswerId: string }>[]) => {
      for (const job of jobs) {
        const { learnedAnswerId } = learnDistillJobSchema.parse(job.data);
        try {
          await distillLearnedAnswer(learnedAnswerId);
        } catch (err) {
          const isFinal = job.retryCount >= LEARN_DISTILL_RETRY_LIMIT;
          logger.error(
            { err: toErrorInfo(err), learnedAnswerId, retryCount: job.retryCount, final: isFinal },
            'learn-distill failed'
          );
          if (isFinal) {
            // Mark 'error' so the scan stops re-enqueuing (no paid LLM loop).
            await markLearnDistillFailed(learnedAnswerId);
            return;
          }
          throw err; // let pg-boss retry
        }
      }
    }
  );

  const stopScan = startScan(boss, logger);
  // Voice dispatch: Realtime-subscribed call intake + WS sessions (Phase 9).
  const voice = startVoiceDispatch(logger);

  // initial heartbeat so the container reports healthy right after boot
  await writeHeartbeat();
  logger.info('worker started');

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    stopScan();
    void voice
      .stop()
      .catch((err: unknown) =>
        logger.error({ err: toErrorInfo(err) }, 'error during voice dispatch stop')
      )
      .then(() => boss.stop())
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
