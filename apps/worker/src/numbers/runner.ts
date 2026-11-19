import type { Logger } from '@zendori/core';
import { loadWorkerEnv } from '@zendori/core';
import { getServiceClient, isMissingColumnError, toErrorInfo } from '../db.js';
import { createTwilioNumbersApi, createXaiNumbersApi } from './api.js';
import {
  INTERRUPTED_ERROR,
  provisionAndRecord,
  resolveProvisionConfig,
  type ProvisionRow,
} from './provision.js';
import { createSupabaseProvisionStore } from './store.js';

// Number provisioning runner (0033). Polls phone_numbers for rows an admin
// approved ("Kostenpflichtig bestellen" / "Erneut versuchen" → status
// 'provisioning', provision_started_at null), claims ONE at a time atomically
// and runs the resumable provisioning steps. Not latency-critical, so a plain
// 5 s poll (no Realtime). The loop always runs: missing provider config fails
// the claimed row with the variable names, so the admin sees it in the UI.

const POLL_INTERVAL_MS = 5_000;
/** Per provider request — a hung call must not block the serialized loop. */
const REQUEST_TIMEOUT_MS = 30_000;
const BATCH = 5;

const ROW_FIELDS =
  'id, org_id, number_type, e164, twilio_phone_number_sid, twilio_trunk_sid, xai_phone_number_id, channel_id, channel_name, area_code, provision_attempts';

type ClaimRow = ProvisionRow & { provision_attempts: number };

export interface NumberProvisionerHandle {
  stop: () => Promise<void>;
}

function isMissingTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '42P01';
}

const timedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

export function startNumberProvisioner(logger: Logger): NumberProvisionerHandle {
  const supabase = getServiceClient();
  const store = createSupabaseProvisionStore(supabase);
  let stopped = false;
  let current: Promise<void> | null = null;
  let recovered = false;
  let lastErrorMessage: string | null = null;

  /** Rows left 'provisioning' + claimed by a previous worker process were interrupted. */
  async function recoverInterrupted(): Promise<void> {
    const { data, error } = await supabase
      .from('phone_numbers')
      .update({ status: 'failed', provision_error: INTERRUPTED_ERROR, provision_started_at: null })
      .eq('status', 'provisioning')
      .not('provision_started_at', 'is', null)
      .select('id');
    if (error) throw error;
    if (data && data.length > 0) {
      logger.warn({ count: data.length }, 'number provisioning: interrupted rows marked failed');
    }
  }

  async function processRow(row: ClaimRow): Promise<void> {
    // Atomic claim: only one run per approval, never a second purchase in parallel.
    const { data: claimed, error: claimError } = await supabase
      .from('phone_numbers')
      .update({
        provision_started_at: new Date().toISOString(),
        provision_attempts: row.provision_attempts + 1,
      })
      .eq('id', row.id)
      .eq('status', 'provisioning')
      .is('provision_started_at', null)
      .select('id');
    if (claimError) throw claimError;
    if (!claimed || claimed.length === 0) return;

    const env = loadWorkerEnv();
    const resolved = resolveProvisionConfig(
      {
        TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
        TWILIO_VOICE_TRUNK_SID: env.TWILIO_VOICE_TRUNK_SID,
        TWILIO_BUNDLE_SID: env.TWILIO_BUNDLE_SID,
        TWILIO_BUNDLE_SID_LOCAL: env.TWILIO_BUNDLE_SID_LOCAL,
        TWILIO_BUNDLE_SID_MOBILE: env.TWILIO_BUNDLE_SID_MOBILE,
        TWILIO_BUNDLE_SID_NATIONAL: env.TWILIO_BUNDLE_SID_NATIONAL,
        TWILIO_ADDRESS_SID_LOCAL: env.TWILIO_ADDRESS_SID_LOCAL,
        XAI_API_KEY: env.XAI_API_KEY,
        APP_URL: env.APP_URL,
        MASTER_ENCRYPTION_KEY: env.MASTER_ENCRYPTION_KEY,
      },
      row
    );
    if (!resolved.ok) {
      await store.updateRow(row.id, {
        status: 'failed',
        provision_error: resolved.error,
        provision_started_at: null,
      });
      logger.warn({ phoneNumberId: row.id }, 'number provisioning: worker config incomplete');
      return;
    }
    const { config } = resolved;

    const twilio = createTwilioNumbersApi({
      accountSid: config.accountSid,
      authToken: config.authToken,
      ...(config.addressSidOverride ? { addressSidOverride: config.addressSidOverride } : {}),
      fetchImpl: timedFetch,
      ...(process.env.TWILIO_API_BASE ? { apiBase: process.env.TWILIO_API_BASE } : {}),
      ...(process.env.TWILIO_NUMBERS_API_BASE
        ? { numbersBase: process.env.TWILIO_NUMBERS_API_BASE }
        : {}),
    });
    const xai = createXaiNumbersApi({
      apiKey: config.xaiApiKey,
      fetchImpl: timedFetch,
      ...(env.XAI_API_BASE?.trim() ? { apiBase: env.XAI_API_BASE.trim() } : {}),
    });

    logger.info(
      { phoneNumberId: row.id, orgId: row.org_id, attempt: row.provision_attempts + 1 },
      'number provisioning started'
    );
    const outcome = await provisionAndRecord(row, { store, twilio, xai, config });
    if (outcome.ok) {
      logger.info(
        { phoneNumberId: row.id, orgId: row.org_id, channelId: outcome.result.channelId },
        'number provisioned'
      );
    } else {
      // admin-facing text: provider error, no secrets, no customer content
      logger.error({ phoneNumberId: row.id, error: outcome.error }, 'number provisioning failed');
    }
  }

  async function sweep(): Promise<void> {
    if (!recovered) {
      await recoverInterrupted();
      recovered = true;
    }
    const { data, error } = await supabase
      .from('phone_numbers')
      .select(ROW_FIELDS)
      .eq('status', 'provisioning')
      .is('provision_started_at', null)
      .order('approved_at', { ascending: true, nullsFirst: true })
      .limit(BATCH);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as ClaimRow[]) {
      if (stopped) return;
      await processRow(row);
    }
  }

  function tick(): void {
    if (stopped || current) return;
    current = sweep()
      .then(() => {
        lastErrorMessage = null;
      })
      .catch((error: unknown) => {
        // Worker deployed ahead of 0033: stay quiet until the migration lands.
        const message =
          isMissingColumnError(error) || isMissingTable(error)
            ? 'migration 0033 not applied yet'
            : toErrorInfo(error).message;
        if (message !== lastErrorMessage) {
          lastErrorMessage = message;
          logger.warn({ err: toErrorInfo(error) }, `number provisioning sweep failed: ${message}`);
        }
      })
      .finally(() => {
        current = null;
      });
  }

  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);
  logger.info('number provisioner started');

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (current) await current;
    },
  };
}
