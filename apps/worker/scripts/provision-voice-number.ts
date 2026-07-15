// Operator CLI (Phase 9): provisions a voice number for an org end-to-end.
//
//   1. search + buy a DE number at Twilio (VoiceEnabled) of the requested --type
//      (national | local | mobile), using the matching Novax regulatory bundle
//   2. attach it to the shared Elastic SIP trunk (origination → sip.voice.x.ai)
//   3. create the Zendori voice channel row (draft config, German defaults)
//   4. register the number at xAI (byo_trunk) with the per-channel webhook URL
//      and store the ONE-TIME dispatch signing secret encrypted in the config
//
// Usage (from apps/worker, .env at repo root loaded via --env-file):
//   npx tsx --env-file=../../.env scripts/provision-voice-number.ts \
//     --org <org-uuid> --name "Telefon Strong Energy" \
//     --type local|mobile|national [--number +49…] [--dry-run]
//
// Required env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VOICE_TRUNK_SID,
//   XAI_API_KEY, APP_URL, MASTER_ENCRYPTION_KEY, SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY, and a regulatory bundle for each --type you use:
//   TWILIO_BUNDLE_SID_LOCAL / _MOBILE (or _NATIONAL); legacy TWILIO_BUNDLE_SID also works.
// The one-time trunk + bundle setup is documented in docs/phase-9-voice.md.
import { encryptSecret, createServiceRoleClient } from '@zendori/core';
import { voiceChannelConfigSchema } from '@zendori/channels';

const TWILIO_BASE = process.env.TWILIO_API_BASE?.replace(/\/+$/, '') || 'https://api.twilio.com';
const XAI_BASE = process.env.XAI_API_BASE?.replace(/\/+$/, '') || 'https://api.x.ai';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// DE number types map to distinct Twilio search endpoints AND distinct regulatory
// bundles — national/local/mobile each need their own approved bundle. --type picks
// both. Local (geographic) numbers carry a per-city address requirement, so they are
// NOT excluded from the search the way national/mobile are.
const NUMBER_TYPES = {
  national: { endpoint: 'National', excludeAddressRequired: true },
  local: { endpoint: 'Local', excludeAddressRequired: false },
  mobile: { endpoint: 'Mobile', excludeAddressRequired: true },
} as const;
type NumberType = keyof typeof NUMBER_TYPES;

// --type is REQUIRED (no default): with one bundle per number type there is no
// single sensible default, and a wrong guess would buy the wrong number / miss a
// bundle. Force the operator to state it.
function resolveType(): NumberType {
  const raw = arg('--type')?.toLowerCase();
  if (!raw || !(raw in NUMBER_TYPES)) {
    console.error('Missing or invalid --type: use local | mobile | national.');
    process.exit(1);
  }
  return raw as NumberType;
}

// The bundle is an operator asset (Novax owns one per DE number type), never per-org.
// Prefer the type-specific env; fall back to the legacy single var (= national).
function bundleForType(type: NumberType): string {
  const sid =
    process.env[`TWILIO_BUNDLE_SID_${type.toUpperCase()}`] || process.env.TWILIO_BUNDLE_SID;
  if (!sid) {
    console.error(
      `Missing bundle SID for --type ${type}: set TWILIO_BUNDLE_SID_${type.toUpperCase()} (or legacy TWILIO_BUNDLE_SID).`
    );
    process.exit(1);
  }
  return sid;
}

async function twilioRequest(path: string, params?: URLSearchParams): Promise<unknown> {
  const sid = requireEnv('TWILIO_ACCOUNT_SID');
  const token = requireEnv('TWILIO_AUTH_TOKEN');
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(`${TWILIO_BASE}${path}`, {
    method: params ? 'POST' : 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(params ? { body: params.toString() } : {}),
  });
  if (!res.ok) {
    throw new Error(`Twilio ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

async function trunkingRequest(path: string, params: URLSearchParams): Promise<unknown> {
  const sid = requireEnv('TWILIO_ACCOUNT_SID');
  const token = requireEnv('TWILIO_AUTH_TOKEN');
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const base =
    process.env.TWILIO_TRUNKING_API_BASE?.replace(/\/+$/, '') || 'https://trunking.twilio.com';
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!res.ok) {
    throw new Error(`Twilio trunking ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.json();
}

/** First non-empty string among the given keys (snake_case docs vs camelCase live API). */
function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/**
 * Recursively collect string values under secret-ish keys. Live-gate learning:
 * the phone-number API answers in camelCase (phoneNumberId, …), so the exact
 * secret field name must not be hardcoded — prefer keys mentioning
 * signing/dispatch, fall back to any *secret* key.
 */
function collectSecrets(node: unknown, out: { key: string; value: string }[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectSecrets(item, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === 'string' && v && /secret/i.test(k)) out.push({ key: k, value: v });
      else collectSecrets(v, out);
    }
  }
}

function findSigningSecret(response: unknown): { key: string; value: string } | null {
  const candidates: { key: string; value: string }[] = [];
  collectSecrets(response, candidates);
  return (
    candidates.find((c) => /signing|dispatch/i.test(c.key)) ?? candidates[0] ?? null
  );
}

/** Response shape for error output — every secret-ish value masked. */
function maskedShape(obj: unknown): string {
  return JSON.stringify(
    obj,
    (k, v: unknown) =>
      typeof v === 'string' && /secret|token|key/i.test(k) ? `<masked ${v.length} chars>` : v,
    2
  );
}

interface RegisterDeps {
  supabase: ReturnType<typeof createServiceRoleClient>;
  xaiKey: string;
  appUrl: string;
  masterKey: string;
  channelId: string;
  name: string;
  phoneNumber: string;
  /** Base channel config to merge the xAI id + encrypted secret into. */
  config: Record<string, unknown>;
}

/**
 * Step 4 (shared by the full flow and --complete-channel resume): register the
 * number at xAI, store the ONE-TIME dispatch signing secret encrypted, activate
 * the channel. The secret is returned exactly once, so persistence failures
 * print the ciphertext for manual recovery.
 */
async function registerAndActivate(d: RegisterDeps): Promise<void> {
  const webhookUrl = `${d.appUrl}/api/hooks/voice?channel=${d.channelId}`;
  const res = await fetch(`${XAI_BASE}/v2/phone-numbers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${d.xaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: 'byo_trunk',
      name: d.name,
      phone_number: d.phoneNumber,
      webhook: { url: webhookUrl },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `xAI phone-number registration → ${res.status}: ${(await res.text()).slice(0, 300)}`
    );
  }
  const registered = (await res.json()) as Record<string, unknown>;
  const xaiId = firstString(registered, ['phoneNumberId', 'id', 'phone_number_id']);
  const secret = findSigningSecret(registered);
  if (!secret) {
    console.error('xAI response contained no secret-like field. Shape (secrets masked):');
    console.error(maskedShape(registered));
    throw new Error('xAI did not return a dispatch signing secret — see response shape above');
  }
  console.log(`Signing secret received (field: ${secret.key})`);

  const secretEncrypted = await encryptSecret(secret.value, d.masterKey);
  const finalConfig = voiceChannelConfigSchema.parse({
    ...d.config,
    xaiPhoneNumberId: xaiId,
    dispatchSigningSecretEncrypted: secretEncrypted,
  });
  const { error: updateError } = await d.supabase
    .from('channels')
    .update({ config: finalConfig, is_active: true })
    .eq('id', d.channelId);
  if (updateError) {
    console.error('CHANNEL UPDATE FAILED — the one-time signing secret would be lost!');
    console.error('Manual recovery: set channels.config for channel', d.channelId, 'to include:');
    console.error(`  dispatchSigningSecretEncrypted: ${secretEncrypted}`);
    console.error(`  xaiPhoneNumberId: ${registered.id ?? '(unknown)'}`);
    console.error('…then set is_active=true. (Value above is libsodium ciphertext, safe to copy.)');
    throw new Error(`channel update failed: ${updateError.message}`);
  }

  console.log('Done.');
  console.log(`  Nummer:      ${d.phoneNumber}`);
  console.log(`  Channel:     ${d.channelId}`);
  console.log(`  Webhook-URL: ${webhookUrl}`);
  console.log('  Kunde: Rufumleitung der bestehenden Nummer auf die Twilio-Nummer einrichten.');
}

async function main(): Promise<void> {
  // Deps shared by the full flow and the --complete-channel resume.
  const xaiKey = requireEnv('XAI_API_KEY');
  const appUrl = requireEnv('APP_URL').replace(/\/+$/, '');
  const masterKey = requireEnv('MASTER_ENCRYPTION_KEY');
  const supabase = createServiceRoleClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  );

  // --- resume mode: number already bought, redo ONLY the xAI registration for
  // an existing channel (e.g. step 4 failed because xAI had no credits). No
  // Twilio, no second purchase.
  const completeChannelId = arg('--complete-channel');
  if (completeChannelId) {
    const { data, error } = await supabase
      .from('channels')
      .select('name, type, config')
      .eq('id', completeChannelId)
      .single();
    if (error || !data) {
      throw new Error(`channel ${completeChannelId} not found: ${error?.message ?? 'no row'}`);
    }
    const row = data as { name: string; type: string; config: Record<string, unknown> };
    if (row.type !== 'voice') throw new Error(`channel ${completeChannelId} is not a voice channel`);
    const phoneNumber = typeof row.config.phoneNumber === 'string' ? row.config.phoneNumber : '';
    if (!phoneNumber) throw new Error(`channel ${completeChannelId} has no phoneNumber in config`);
    console.log(`Resuming xAI registration for channel ${completeChannelId} (${phoneNumber})`);

    // The one-time secret of a previous registration is NOT retrievable. If the
    // number is already registered at xAI (e.g. an earlier resume registered it
    // but the secret parse failed), delete that registration first and
    // re-register for a fresh secret — the recovery cycle documented above.
    const listRes = await fetch(`${XAI_BASE}/v2/phone-numbers`, {
      headers: { Authorization: `Bearer ${xaiKey}` },
    });
    if (listRes.ok) {
      const listRaw = (await listRes.json()) as Record<string, unknown>;
      const numbers = (listRaw.phoneNumbers ??
        listRaw.phone_numbers ??
        []) as Record<string, unknown>[];
      const existing = numbers.find(
        (n) => n.phoneNumber === phoneNumber || n.phone_number === phoneNumber
      );
      const existingId = existing
        ? firstString(existing, ['phoneNumberId', 'id', 'phone_number_id'])
        : undefined;
      if (existingId) {
        console.log(`Existing xAI registration ${existingId} found — deleting for a fresh secret…`);
        const delRes = await fetch(`${XAI_BASE}/v2/phone-numbers/${existingId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${xaiKey}` },
        });
        if (!delRes.ok) {
          throw new Error(
            `xAI deregistration → ${delRes.status}: ${(await delRes.text()).slice(0, 300)}`
          );
        }
      }
    }

    await registerAndActivate({
      supabase,
      xaiKey,
      appUrl,
      masterKey,
      channelId: completeChannelId,
      name: row.name,
      phoneNumber,
      config: row.config,
    });
    return;
  }

  // --- full provisioning flow ------------------------------------------------
  const orgId = arg('--org');
  const name = arg('--name');
  const wantedNumber = arg('--number');
  const dryRun = process.argv.includes('--dry-run');
  if (!orgId || !name) {
    console.error(
      'Usage: provision-voice-number.ts --org <uuid> --name "<channel name>" --type local|mobile|national [--number +49…] [--dry-run]\n' +
        '   or: --complete-channel <channel-uuid>   (resume xAI registration, no re-buy)'
    );
    process.exit(1);
  }
  const type = resolveType();

  const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
  const bundleSid = bundleForType(type);
  const trunkSid = requireEnv('TWILIO_VOICE_TRUNK_SID');

  // 1. pick a number: explicit --number, else search DE for the requested type.
  const { endpoint, excludeAddressRequired } = NUMBER_TYPES[type];
  let phoneNumber = wantedNumber;
  if (!phoneNumber) {
    const query = new URLSearchParams({ VoiceEnabled: 'true', PageSize: '5' });
    if (excludeAddressRequired) query.set('ExcludeAllAddressRequired', 'true');
    const search = (await twilioRequest(
      `/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/DE/${endpoint}.json?${query.toString()}`
    )) as { available_phone_numbers?: { phone_number: string }[] };
    phoneNumber = search.available_phone_numbers?.[0]?.phone_number;
    if (!phoneNumber) throw new Error(`no available DE ${type} number found`);
  }
  console.log(`Number (${type}): ${phoneNumber}${dryRun ? ' (dry-run: not buying)' : ''}`);
  if (dryRun) return;

  // 2. buy + attach to the trunk (TrunkSid ⇒ all voice URLs are ignored).
  const bought = (await twilioRequest(
    `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`,
    new URLSearchParams({ PhoneNumber: phoneNumber, BundleSid: bundleSid, TrunkSid: trunkSid })
  )) as { sid: string; phone_number: string };
  console.log(`Bought ${bought.phone_number} (${bought.sid}), attached to trunk ${trunkSid}`);
  void trunkingRequest; // trunk attach via TrunkSid on purchase; helper kept for per-number trunks

  // 3. create the Zendori voice channel (draft config; secret added in step 4).
  // Behavioral config (mode/identity) lives on the assigned agent (0011) — the
  // owner assigns one in the channel settings after provisioning.
  const draftConfig = {
    type: 'voice',
    provider: 'xai',
    phoneNumber: bought.phone_number,
    twilioPhoneNumberSid: bought.sid,
    twilioTrunkSid: trunkSid,
    dispatchSigningSecretEncrypted: 'pending',
    voice: 'eve',
    languageHint: 'de',
    keyterms: [],
    speechSpeed: 1.0,
    maxCallSeconds: 900,
    connectionState: 'active',
  };
  const { data: channelRow, error: channelError } = await supabase
    .from('channels')
    .insert({ org_id: orgId, type: 'voice', name, is_active: false, config: draftConfig })
    .select('id')
    .single();
  if (channelError || !channelRow) {
    throw new Error(`channel insert failed: ${channelError?.message}`);
  }
  const channelId = (channelRow as { id: string }).id;
  console.log(`Channel ${channelId} created (inactive until secret is stored)`);

  // 4. register at xAI + store the one-time secret + activate the channel.
  await registerAndActivate({
    supabase,
    xaiKey,
    appUrl,
    masterKey,
    channelId,
    name,
    phoneNumber: bought.phone_number,
    config: draftConfig,
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
