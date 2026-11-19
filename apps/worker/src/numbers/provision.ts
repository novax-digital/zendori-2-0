import { encryptSecret, type PhoneNumberType } from '@zendori/core';
import { voiceChannelConfigSchema } from '@zendori/channels';
import {
  TwilioApiError,
  XaiApiError,
  type BoughtNumber,
  type TwilioNumbersApi,
  type XaiNumbersApi,
} from './api.js';

// Automatic phone-number provisioning (0033) — the worker-side replacement of
// scripts/provision-voice-number.ts --request. Steps, each RESUMABLE so an
// admin "Erneut versuchen" continues where a failure stopped:
//   a. quota pre-check (only before anything is bought)
//   b. buy at Twilio — guarded by a FriendlyName lookup, so a crash between
//      purchase and persist never buys a second number
//   c. voice channel (reuses an org channel already carrying the number)
//   d. xAI registration + ONE-TIME signing secret → encrypted into the channel
//      config, channel activated (re-registers if the secret is still pending)
//   e. inventory row → active
// Every step persists its result on the phone_numbers row immediately.

const PROVISION_ERROR_MAX = 500;

export const NUMBER_TYPE_LABELS: Record<PhoneNumberType, string> = {
  local: 'Ortsnetz',
  mobile: 'Mobilfunk',
  national: 'National (032)',
};

export const INTERRUPTED_ERROR =
  'Unterbrochen (Worker-Neustart) – „Erneut versuchen" setzt an der Stelle fort.';

/** Columns of a phone_numbers row the provisioner reads (0016 + 0033). */
export interface ProvisionRow {
  id: string;
  org_id: string;
  number_type: PhoneNumberType;
  e164: string | null;
  twilio_phone_number_sid: string | null;
  twilio_trunk_sid: string | null;
  xai_phone_number_id: string | null;
  channel_id: string | null;
  channel_name: string | null;
  area_code: string | null;
}

export type ProvisionRowPatch = Partial<{
  status: 'active' | 'failed';
  e164: string;
  number_type: PhoneNumberType;
  twilio_phone_number_sid: string;
  twilio_trunk_sid: string;
  xai_phone_number_id: string | null;
  channel_id: string;
  activated_at: string;
  provision_error: string | null;
  provision_started_at: string | null;
}>;

export interface VoiceChannelRecord {
  id: string;
  name: string;
  isActive: boolean;
  config: Record<string, unknown>;
}

/** DB operations of the provisioner (Supabase in prod, in-memory in tests). Throw on error. */
export interface ProvisionStore {
  voiceQuota(orgId: string): Promise<{ limit: number | null; count: number }>;
  orgName(orgId: string): Promise<string | null>;
  updateRow(id: string, patch: ProvisionRowPatch): Promise<void>;
  findVoiceChannelByNumber(orgId: string, e164: string): Promise<VoiceChannelRecord | null>;
  getChannel(id: string): Promise<VoiceChannelRecord | null>;
  insertChannel(orgId: string, name: string, config: Record<string, unknown>): Promise<string>;
  activateChannel(id: string, config: Record<string, unknown>): Promise<void>;
}

// --- configuration ------------------------------------------------------------------

/** Worker env slice the provisioner needs (all optional — missing ones fail the row). */
export interface ProvisionEnv {
  TWILIO_ACCOUNT_SID?: string | undefined;
  TWILIO_AUTH_TOKEN?: string | undefined;
  TWILIO_VOICE_TRUNK_SID?: string | undefined;
  TWILIO_BUNDLE_SID?: string | undefined;
  TWILIO_BUNDLE_SID_LOCAL?: string | undefined;
  TWILIO_BUNDLE_SID_MOBILE?: string | undefined;
  TWILIO_BUNDLE_SID_NATIONAL?: string | undefined;
  TWILIO_ADDRESS_SID_LOCAL?: string | undefined;
  XAI_API_KEY?: string | undefined;
  APP_URL?: string | undefined;
  MASTER_ENCRYPTION_KEY?: string | undefined;
}

export interface ProvisionConfig {
  accountSid: string;
  authToken: string;
  trunkSid: string;
  /** Regulatory bundle for the row's type; only resolved while a purchase is pending. */
  bundleSid: string | null;
  addressSidOverride: string | undefined;
  xaiApiKey: string;
  /** https, without trailing slash — xAI registers the webhook URL FIX per number. */
  appUrl: string;
  masterKey: string;
}

const BUNDLE_ENV: Record<PhoneNumberType, keyof ProvisionEnv> = {
  local: 'TWILIO_BUNDLE_SID_LOCAL',
  mobile: 'TWILIO_BUNDLE_SID_MOBILE',
  national: 'TWILIO_BUNDLE_SID_NATIONAL',
};

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolves the provider config for one row. Missing variables are reported BY
 * NAME (never values) so the admin sees what to set on the VPS.
 */
export function resolveProvisionConfig(
  env: ProvisionEnv,
  row: Pick<ProvisionRow, 'number_type' | 'twilio_phone_number_sid' | 'twilio_trunk_sid'>
): { ok: true; config: ProvisionConfig } | { ok: false; error: string } {
  const missing: string[] = [];
  const need = (name: keyof ProvisionEnv): string => {
    const value = present(env[name]);
    if (!value) missing.push(name);
    return value ?? '';
  };
  const accountSid = need('TWILIO_ACCOUNT_SID');
  const authToken = need('TWILIO_AUTH_TOKEN');
  // A resumed row keeps the trunk it was bought onto.
  const trunkSid = present(row.twilio_trunk_sid ?? undefined) ?? need('TWILIO_VOICE_TRUNK_SID');
  let bundleSid: string | null = null;
  if (!row.twilio_phone_number_sid) {
    const typed = BUNDLE_ENV[row.number_type];
    bundleSid = present(env[typed]) ?? present(env.TWILIO_BUNDLE_SID) ?? null;
    if (!bundleSid) missing.push(typed);
  }
  const xaiApiKey = need('XAI_API_KEY');
  const masterKey = need('MASTER_ENCRYPTION_KEY');
  const appUrlRaw = need('APP_URL');

  if (missing.length > 0) {
    return {
      ok: false,
      error: `Worker-Konfiguration unvollständig: ${missing.join(', ')} fehlt (in /opt/zendori-worker/.env setzen, Worker neu starten, dann „Erneut versuchen").`,
    };
  }
  if (!/^https:\/\//i.test(appUrlRaw)) {
    return {
      ok: false,
      error:
        'APP_URL des Workers muss die öffentliche https-Adresse sein (xAI registriert die Webhook-URL fest pro Nummer).',
    };
  }
  return {
    ok: true,
    config: {
      accountSid,
      authToken,
      trunkSid,
      bundleSid,
      addressSidOverride: present(env.TWILIO_ADDRESS_SID_LOCAL),
      xaiApiKey,
      appUrl: appUrlRaw.replace(/\/+$/, ''),
      masterKey,
    },
  };
}

// --- errors -------------------------------------------------------------------------

/** A failure whose message is already admin-facing German copy. */
export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisionError';
  }
}

/**
 * Admin-facing failure text: German prefix per provider, truncated, and every
 * known secret value redacted (defense in depth — provider/DB messages should
 * never echo one, but the one-time xAI secret must not land in a column).
 */
export function describeProvisionError(error: unknown, secrets: readonly string[] = []): string {
  let message: string;
  if (error instanceof ProvisionError) {
    message = error.message;
  } else if (error instanceof TwilioApiError) {
    message = `Twilio${error.code ? ` (Code ${error.code})` : ''} – ${error.message}`;
  } else if (error instanceof XaiApiError) {
    message = `xAI – ${error.message}`;
  } else if (error instanceof Error) {
    message = `Fehler – ${error.message}`;
  } else {
    message = `Fehler – ${String(error)}`;
  }
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('***');
  }
  return message.length > PROVISION_ERROR_MAX
    ? `${message.slice(0, PROVISION_ERROR_MAX - 1)}…`
    : message;
}

// --- provisioning -------------------------------------------------------------------

export interface ProvisionDeps {
  store: ProvisionStore;
  twilio: TwilioNumbersApi;
  xai: XaiNumbersApi;
  config: ProvisionConfig;
  now?: () => Date;
}

/** Twilio FriendlyName marking a purchase for this row (idempotency key, ≤ 64 chars). */
export function purchaseFriendlyName(rowId: string): string {
  return `zendori-pn-${rowId}`;
}

/** Draft voice channel config — inactive until the xAI secret is stored (script parity). */
export function draftVoiceConfig(input: {
  phoneNumber: string;
  twilioPhoneNumberSid: string;
  twilioTrunkSid: string;
}): Record<string, unknown> {
  return {
    type: 'voice',
    provider: 'xai',
    phoneNumber: input.phoneNumber,
    twilioPhoneNumberSid: input.twilioPhoneNumberSid,
    twilioTrunkSid: input.twilioTrunkSid,
    dispatchSigningSecretEncrypted: 'pending',
    voice: 'eve',
    languageHint: 'de',
    keyterms: [],
    speechSpeed: 1.0,
    maxCallSeconds: 900,
    connectionState: 'active',
  };
}

function secretPending(config: Record<string, unknown>): boolean {
  const value = config.dispatchSigningSecretEncrypted;
  return typeof value !== 'string' || value.length === 0 || value === 'pending';
}

export interface ProvisionResult {
  e164: string;
  channelId: string;
}

/**
 * Runs the remaining steps for a claimed row. Throws on failure — the row's
 * persisted progress (number, channel) is kept for the resume.
 * `secrets` collects one-time values for redaction by the caller.
 */
export async function provisionPhoneNumber(
  initial: ProvisionRow,
  deps: ProvisionDeps,
  secrets: string[] = []
): Promise<ProvisionResult> {
  const { store, twilio, xai, config } = deps;
  const now = deps.now ?? (() => new Date());
  const row: ProvisionRow = { ...initial };

  // a + b: number ----------------------------------------------------------------------
  if (!row.twilio_phone_number_sid || !row.e164) {
    const friendlyName = purchaseFriendlyName(row.id);
    let bought: BoughtNumber | null = await twilio.findIncomingByFriendlyName(friendlyName);
    if (!bought) {
      const quota = await store.voiceQuota(row.org_id);
      if (quota.limit !== null && quota.count >= quota.limit) {
        throw new ProvisionError(
          `Voice-Kanal-Kontingent des Kunden erreicht (${quota.count}/${quota.limit}) – in Admin → Kunde erhöhen, dann „Erneut versuchen".`
        );
      }
      const areaCode = row.area_code ?? undefined;
      const candidates = await twilio.searchAvailable(row.number_type, areaCode ? { areaCode } : {});
      const phoneNumber = candidates[0];
      if (!phoneNumber) {
        throw new ProvisionError(
          areaCode
            ? `Keine freie Nummer mit Vorwahl 0${areaCode} – Vorwahl leeren oder ändern und erneut versuchen.`
            : `Twilio hat aktuell keine freie ${NUMBER_TYPE_LABELS[row.number_type]}-Nummer in Deutschland.`
        );
      }
      if (!config.bundleSid) {
        throw new ProvisionError('Kein Regulatory-Bundle für diesen Nummerntyp konfiguriert.');
      }
      const addressSid =
        row.number_type === 'local'
          ? (config.addressSidOverride ?? (await twilio.addressSidForBundle(config.bundleSid)))
          : undefined;
      bought = await twilio.purchase({
        phoneNumber,
        bundleSid: config.bundleSid,
        trunkSid: config.trunkSid,
        friendlyName,
        ...(addressSid ? { addressSid } : {}),
      });
    }
    // Persist the (paid) purchase before anything else can fail.
    await store.updateRow(row.id, {
      e164: bought.phoneNumber,
      number_type: row.number_type,
      twilio_phone_number_sid: bought.sid,
      twilio_trunk_sid: config.trunkSid,
    });
    row.e164 = bought.phoneNumber;
    row.twilio_phone_number_sid = bought.sid;
    row.twilio_trunk_sid = config.trunkSid;
  }
  const e164 = row.e164;
  const numberSid = row.twilio_phone_number_sid;
  if (!e164 || !numberSid) {
    throw new ProvisionError('Nummer konnte nicht ermittelt werden (Twilio-Kauf unvollständig).');
  }

  // c: channel -------------------------------------------------------------------------
  let channelId = row.channel_id;
  if (!channelId) {
    const existing = await store.findVoiceChannelByNumber(row.org_id, e164);
    if (existing) {
      channelId = existing.id;
    } else {
      const name =
        row.channel_name?.trim() || `Telefon ${(await store.orgName(row.org_id)) ?? 'Kunde'}`;
      channelId = await store.insertChannel(
        row.org_id,
        name,
        draftVoiceConfig({
          phoneNumber: e164,
          twilioPhoneNumberSid: numberSid,
          twilioTrunkSid: row.twilio_trunk_sid ?? config.trunkSid,
        })
      );
    }
    await store.updateRow(row.id, { channel_id: channelId });
  }

  // d: xAI registration ----------------------------------------------------------------
  const channel = await store.getChannel(channelId);
  if (!channel) {
    throw new ProvisionError(`Voice-Kanal ${channelId} nicht gefunden.`);
  }
  let xaiPhoneNumberId =
    typeof channel.config.xaiPhoneNumberId === 'string' ? channel.config.xaiPhoneNumberId : null;
  if (secretPending(channel.config)) {
    // The secret is returned exactly once: an earlier registration whose secret
    // never got stored is useless — drop it and register fresh.
    const registeredId = await xai.findByNumber(e164);
    if (registeredId) await xai.remove(registeredId);
    const registration = await xai.register({
      name: channel.name,
      phoneNumber: e164,
      webhookUrl: `${config.appUrl}/api/hooks/voice?channel=${channelId}`,
    });
    secrets.push(registration.secret);
    const encrypted = await encryptSecret(registration.secret, config.masterKey);
    const finalConfig = voiceChannelConfigSchema.parse({
      ...channel.config,
      ...(registration.id ? { xaiPhoneNumberId: registration.id } : {}),
      dispatchSigningSecretEncrypted: encrypted,
    });
    await store.activateChannel(channelId, finalConfig);
    xaiPhoneNumberId = registration.id ?? xaiPhoneNumberId;
  }

  // e: inventory row → active ------------------------------------------------------------
  await store.updateRow(row.id, {
    status: 'active',
    xai_phone_number_id: xaiPhoneNumberId,
    activated_at: now().toISOString(),
    provision_error: null,
    provision_started_at: null,
  });
  return { e164, channelId };
}

/**
 * Provision + record the outcome: on failure the row goes to 'failed' with an
 * admin-facing, secret-free error and is released for "Erneut versuchen".
 */
export async function provisionAndRecord(
  row: ProvisionRow,
  deps: ProvisionDeps
): Promise<{ ok: true; result: ProvisionResult } | { ok: false; error: string }> {
  const secrets: string[] = [];
  try {
    return { ok: true, result: await provisionPhoneNumber(row, deps, secrets) };
  } catch (error) {
    const message = describeProvisionError(error, secrets);
    await deps.store.updateRow(row.id, {
      status: 'failed',
      provision_error: message,
      provision_started_at: null,
    });
    return { ok: false, error: message };
  }
}
