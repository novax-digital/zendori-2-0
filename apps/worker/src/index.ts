import { PgBoss } from 'pg-boss';
import type { JobWithMetadata } from 'pg-boss';
import { z } from 'zod';
import { createLogger, loadWorkerEnv } from '@zendori/core';
import { writeHeartbeat } from './heartbeat.js';
import { getServiceClient, toErrorInfo } from './db.js';
import { handlePipelineFailure, processMessage } from './pipeline/process-message.js';
import { indexSource, markIndexSourceFailed } from './pipeline/index-source.js';
import {
  markHubspotSyncTerminal,
  markTicketHubspotSyncTerminal,
  syncConversation,
  syncTicket,
} from './pipeline/hubspot-sync.js';
import {
  HUBSPOT_SYNC_QUEUE,
  HUBSPOT_TICKET_SYNC_QUEUE,
  HUBSPOT_SYNC_RETRY_LIMIT,
  INDEX_SOURCE_QUEUE,
  INDEX_SOURCE_RETRY_LIMIT,
  PROCESS_MESSAGE_QUEUE,
  PROCESS_MESSAGE_RETRY_LIMIT,
  startScan,
} from './scan.js';
import { startVoiceDispatch } from './voice/dispatch.js';
import { startDemoRunner } from './demo/runner.js';
import { startNumberProvisioner } from './numbers/runner.js';
import {
  POST_CALL_QUEUE,
  POST_CALL_RETRY_LIMIT,
  markPostCallTerminal,
  processPostCall,
} from './pipeline/post-call.js';
import { FORM_NOTIFY_QUEUE, processFormNotification } from './pipeline/form-notify.js';
import { ACTION_RUN_QUEUE, executeQueuedRun } from './actions/execute.js';
import { INTEGRATION_EVENT_QUEUE, deliverIntegrationEvent } from './actions/events.js';
import { MCP_SYNC_QUEUE, syncMcpConnection } from './actions/mcp-sync.js';
import { MEMBER_NOTIFY_QUEUE, deliverMemberNotification } from './notifications/deliver.js';
import { workerStripe } from './billing/stripe.js';
import { BILLING_SYNC_QUEUE, syncBillingCustomer } from './billing/customer-sync.js';
import { sendBillingSetupMail } from './billing/setup-mail.js';
import { INVOICE_DOCUMENT_QUEUE, processInvoiceDocument } from './billing/invoice-document.js';
import { INVOICE_RUN_QUEUE, runInvoiceMonth } from './billing/invoice-run.js';
import { INVOICE_COLLECT_QUEUE, processInvoiceCollection } from './billing/invoice-collect.js';
import { STRIPE_EVENT_QUEUE, processStripeEvent } from './billing/stripe-events.js';
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
const hubspotTicketSyncJobSchema = z.object({ ticketId: z.uuid() });
const postCallJobSchema = z.object({ voiceCallId: z.uuid() });
const formNotifyJobSchema = z.object({ notificationId: z.uuid() });
const learnDistillJobSchema = z.object({ learnedAnswerId: z.uuid() });
const actionRunJobSchema = z.object({ runId: z.uuid() });
const integrationEventJobSchema = z.object({ eventId: z.uuid() });
const mcpSyncJobSchema = z.object({ connectionId: z.uuid() });
const memberNotifyJobSchema = z.object({ notificationId: z.uuid() });
const stripeEventJobSchema = z.object({ eventId: z.string().min(1).max(255) });
const billingSyncJobSchema = z.object({ orgId: z.uuid() });
const invoiceDocumentJobSchema = z.object({ invoiceId: z.uuid() });
const invoiceRunJobSchema = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) });

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
  await ensureQueuePolicy(boss, HUBSPOT_TICKET_SYNC_QUEUE);

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

  // --- Phase-11b ticket stream → HubSpot ------------------------------------------
  await boss.work(
    HUBSPOT_TICKET_SYNC_QUEUE,
    { includeMetadata: true },
    async (jobs: JobWithMetadata<{ ticketId: string }>[]) => {
      for (const job of jobs) {
        const { ticketId } = hubspotTicketSyncJobSchema.parse(job.data);
        try {
          await syncTicket(ticketId);
        } catch (err) {
          const isFinal = job.retryCount >= HUBSPOT_SYNC_RETRY_LIMIT;
          logger.error(
            { err: toErrorInfo(err), ticketId, retryCount: job.retryCount, final: isFinal },
            'hubspot-ticket-sync failed'
          );
          if (isFinal) {
            await markTicketHubspotSyncTerminal(ticketId);
            return;
          }
          throw err;
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

  // --- Phase-13 data actions: test runs + inbox-approved runs --------------------
  // executeQueuedRun claims the row (queued → running) and always ends it as
  // succeeded/failed itself; it never rethrows, so pg-boss never redelivers a
  // (possibly non-idempotent) call to the customer's end system.
  await ensureQueuePolicy(boss, ACTION_RUN_QUEUE);
  await boss.work(
    ACTION_RUN_QUEUE,
    { pollingIntervalSeconds: 1 },
    async (jobs: { data: { runId: string } }[]) => {
      const supabase = getServiceClient();
      for (const job of jobs) {
        const { runId } = actionRunJobSchema.parse(job.data);
        try {
          await executeQueuedRun(
            { supabase, logger, masterKey: env.MASTER_ENCRYPTION_KEY },
            runId
          );
        } catch (err) {
          logger.error({ err: toErrorInfo(err), runId }, 'action run job failed');
        }
      }
    }
  );

  // --- Phase-14a MCP connections: read a server's tool list ----------------------
  // syncMcpConnection claims the connection, reads the list once and writes the
  // outcome (catalog or error code) into the row; a failed read is never
  // redelivered — the owner or the daily re-check asks again.
  await ensureQueuePolicy(boss, MCP_SYNC_QUEUE);
  await boss.work(
    MCP_SYNC_QUEUE,
    { pollingIntervalSeconds: 1 },
    async (jobs: { data: { connectionId: string } }[]) => {
      const supabase = getServiceClient();
      for (const job of jobs) {
        const { connectionId } = mcpSyncJobSchema.parse(job.data);
        try {
          await syncMcpConnection(
            { supabase, logger, masterKey: env.MASTER_ENCRYPTION_KEY },
            connectionId
          );
        } catch (err) {
          logger.error({ err: toErrorInfo(err), connectionId }, 'mcp sync job failed');
        }
      }
    }
  );

  // --- Phase-13c outbound events to the customers' end systems ------------------
  // deliverIntegrationEvent leases the outbox row, sends once and writes the
  // outcome (sent / next attempt / failed) into the row — retries are scheduled
  // there, so a job never needs a pg-boss retry.
  await ensureQueuePolicy(boss, INTEGRATION_EVENT_QUEUE);
  await boss.work(
    INTEGRATION_EVENT_QUEUE,
    { pollingIntervalSeconds: 1 },
    async (jobs: { data: { eventId: string } }[]) => {
      const supabase = getServiceClient();
      for (const job of jobs) {
        const { eventId } = integrationEventJobSchema.parse(job.data);
        try {
          await deliverIntegrationEvent(
            { supabase, logger, masterKey: env.MASTER_ENCRYPTION_KEY },
            eventId
          );
        } catch (err) {
          logger.error({ err: toErrorInfo(err), eventId }, 'integration event job failed');
        }
      }
    }
  );

  // --- member e-mail notifications (0038) ---------------------------------------
  // deliverMemberNotification leases the queue row, re-checks access, sends once
  // and writes the outcome into the row — retries are scheduled there.
  await ensureQueuePolicy(boss, MEMBER_NOTIFY_QUEUE);
  await boss.work(
    MEMBER_NOTIFY_QUEUE,
    { pollingIntervalSeconds: 1 },
    async (jobs: { data: { notificationId: string } }[]) => {
      const supabase = getServiceClient();
      for (const job of jobs) {
        const { notificationId } = memberNotifyJobSchema.parse(job.data);
        try {
          await deliverMemberNotification(
            {
              supabase,
              logger,
              from: process.env.RESEND_FROM,
              appUrl: process.env.APP_URL,
            },
            notificationId
          );
        } catch (err) {
          logger.error({ err: toErrorInfo(err), notificationId }, 'member notification job failed');
        }
      }
    }
  );

  // --- Stripe (Phase 15, 0041) ---------------------------------------------------
  // Both jobs lease their row and keep the retry schedule there. Without
  // STRIPE_SECRET_KEY the scan sends nothing and these handlers stay idle.
  await ensureQueuePolicy(boss, STRIPE_EVENT_QUEUE);
  await boss.work(
    STRIPE_EVENT_QUEUE,
    { pollingIntervalSeconds: 1 },
    async (jobs: { data: { eventId: string } }[]) => {
      const stripe = workerStripe();
      if (!stripe) return;
      const supabase = getServiceClient();
      for (const job of jobs) {
        const { eventId } = stripeEventJobSchema.parse(job.data);
        try {
          await processStripeEvent(
            {
              supabase,
              logger,
              stripe,
              // for the mail to the operator when a charge failed or was reversed
              from: process.env.RESEND_FROM,
              appUrl: process.env.APP_URL,
            },
            eventId
          );
        } catch (err) {
          logger.error({ err: toErrorInfo(err) }, 'stripe event job failed');
        }
      }
    }
  );

  await ensureQueuePolicy(boss, BILLING_SYNC_QUEUE);
  await boss.work(
    BILLING_SYNC_QUEUE,
    { pollingIntervalSeconds: 1 },
    async (jobs: { data: { orgId: string } }[]) => {
      const stripe = workerStripe();
      if (!stripe) return;
      const supabase = getServiceClient();
      for (const job of jobs) {
        const { orgId } = billingSyncJobSchema.parse(job.data);
        try {
          await syncBillingCustomer({ supabase, logger, stripe }, orgId);
        } catch (err) {
          logger.error({ err: toErrorInfo(err), orgId }, 'billing customer sync job failed');
        }
        // 0044: the mail that asks the customer to set up billing — only once
        // the sync above is through (a pending retry ends up here again)
        try {
          await sendBillingSetupMail(
            {
              supabase,
              logger,
              stripe,
              from: process.env.RESEND_FROM,
              appUrl: process.env.APP_URL,
            },
            orgId
          );
        } catch (err) {
          logger.error({ err: toErrorInfo(err), orgId }, 'billing setup mail job failed');
        }
      }
    }
  );

  // --- own invoices (Phase 15b, 0046): PDF + mail of an issued invoice ----------
  // Independent of Stripe: an invoice is issued by the app and finished here.
  await ensureQueuePolicy(boss, INVOICE_DOCUMENT_QUEUE);
  await boss.work(
    INVOICE_DOCUMENT_QUEUE,
    { pollingIntervalSeconds: 1 },
    async (jobs: { data: { invoiceId: string } }[]) => {
      const supabase = getServiceClient();
      for (const job of jobs) {
        const { invoiceId } = invoiceDocumentJobSchema.parse(job.data);
        try {
          await processInvoiceDocument(
            {
              supabase,
              logger,
              from: process.env.RESEND_FROM,
              appUrl: process.env.APP_URL,
            },
            invoiceId
          );
        } catch (err) {
          logger.error({ err: toErrorInfo(err), invoiceId }, 'invoice document job failed');
        }
      }
    }
  );

  // --- monthly invoice run (Phase 15b step 2, 0047) --------------------------------
  // One month at a time: every customer gets the invoice for a finished month.
  await ensureQueuePolicy(boss, INVOICE_RUN_QUEUE);
  await boss.work(
    INVOICE_RUN_QUEUE,
    { pollingIntervalSeconds: 5, batchSize: 1 },
    async (jobs: { data: { period: string } }[]) => {
      const supabase = getServiceClient();
      for (const job of jobs) {
        const { period } = invoiceRunJobSchema.parse(job.data);
        try {
          // with the worker's Stripe mode: customers billed through Stripe get an
          // invoice that is collected (0048)
          await runInvoiceMonth(
            { supabase, logger, stripeLivemode: workerStripe()?.livemode ?? null },
            period
          );
        } catch (err) {
          logger.error({ err: toErrorInfo(err), period }, 'invoice run job failed');
        }
      }
    }
  );

  // --- collecting invoices through Stripe (Phase 15b step 3, 0048) -------------------
  await ensureQueuePolicy(boss, INVOICE_COLLECT_QUEUE);
  await boss.work(
    INVOICE_COLLECT_QUEUE,
    { pollingIntervalSeconds: 5 },
    async (jobs: { data: { invoiceId: string } }[]) => {
      const stripe = workerStripe();
      if (!stripe) return;
      const supabase = getServiceClient();
      for (const job of jobs) {
        const { invoiceId } = invoiceDocumentJobSchema.parse(job.data);
        try {
          await processInvoiceCollection(
            {
              supabase,
              logger,
              stripe,
              from: process.env.RESEND_FROM,
              appUrl: process.env.APP_URL,
            },
            invoiceId
          );
        } catch (err) {
          logger.error({ err: toErrorInfo(err), invoiceId }, 'invoice collection job failed');
        }
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
  // Demo-Anruf (0032): outbound demo calls — disabled without DEMO_VOICE_NUMBER.
  const demo = startDemoRunner(logger);
  // Number provisioning (0033): admin-approved phone_numbers rows → Twilio/xAI.
  const numbers = startNumberProvisioner(logger);

  // initial heartbeat so the container reports healthy right after boot
  await writeHeartbeat();
  logger.info('worker started');

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    stopScan();
    void Promise.all([
      voice
        .stop()
        .catch((err: unknown) =>
          logger.error({ err: toErrorInfo(err) }, 'error during voice dispatch stop')
        ),
      demo
        .stop()
        .catch((err: unknown) =>
          logger.error({ err: toErrorInfo(err) }, 'error during demo runner stop')
        ),
      numbers
        .stop()
        .catch((err: unknown) =>
          logger.error({ err: toErrorInfo(err) }, 'error during number provisioner stop')
        ),
    ])
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
