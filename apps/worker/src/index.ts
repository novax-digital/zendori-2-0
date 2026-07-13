import { PgBoss } from 'pg-boss';
import { createLogger, loadWorkerEnv } from '@zendori/core';
import { writeHeartbeat } from './heartbeat.js';

const logger = createLogger('worker');

const HEARTBEAT_QUEUE = 'worker.heartbeat';

async function main(): Promise<void> {
  const env = loadWorkerEnv();

  // pg-boss requires a session-mode connection (direct port / session pooler),
  // NOT the transaction pooler — see CLAUDE.md §3.
  const boss = new PgBoss({ connectionString: env.DATABASE_URL_SESSION });
  boss.on('error', (error: unknown) => logger.error({ err: error }, 'pg-boss error'));

  await boss.start();
  await boss.createQueue(HEARTBEAT_QUEUE);
  await boss.schedule(HEARTBEAT_QUEUE, '* * * * *');
  await boss.work(HEARTBEAT_QUEUE, async () => {
    await writeHeartbeat();
    logger.debug('heartbeat');
  });

  // initial heartbeat so the container reports healthy right after boot
  await writeHeartbeat();
  logger.info('worker started');

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    void boss
      .stop()
      .catch((err: unknown) => logger.error({ err }, 'error during pg-boss stop'))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
