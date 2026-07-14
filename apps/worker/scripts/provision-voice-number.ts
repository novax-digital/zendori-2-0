// Operator CLI (Phase 9): provisions a voice number for an org end-to-end.
//
//   1. search + buy a DE number at Twilio (VoiceEnabled, no per-city address),
//      using the reusable Novax regulatory bundle
//   2. attach it to the shared Elastic SIP trunk (origination → sip.voice.x.ai)
//   3. create the Zendori voice channel row (draft config, German defaults)
//   4. register the number at xAI (byo_trunk) with the per-channel webhook URL
//      and store the ONE-TIME dispatch signing secret encrypted in the config
//
// Usage (from apps/worker, .env at repo root loaded via --env-file):
//   npx tsx --env-file=../../.env scripts/provision-voice-number.ts \
//     --org <org-uuid> --name "Telefon Strong Energy" [--number +49…] [--dry-run]
//
// Required env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_BUNDLE_SID,
//   TWILIO_VOICE_TRUNK_SID, XAI_API_KEY, APP_URL, MASTER_ENCRYPTION_KEY,
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
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

async function main(): Promise<void> {
  const orgId = arg('--org');
  const name = arg('--name');
  const wantedNumber = arg('--number');
  const dryRun = process.argv.includes('--dry-run');
  if (!orgId || !name) {
    console.error(
      'Usage: provision-voice-number.ts --org <uuid> --name "<channel name>" [--number +49…] [--dry-run]'
    );
    process.exit(1);
  }

  const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
  const bundleSid = requireEnv('TWILIO_BUNDLE_SID');
  const trunkSid = requireEnv('TWILIO_VOICE_TRUNK_SID');
  const xaiKey = requireEnv('XAI_API_KEY');
  const appUrl = requireEnv('APP_URL').replace(/\/+$/, '');
  const masterKey = requireEnv('MASTER_ENCRYPTION_KEY');
  const supabase = createServiceRoleClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  );

  // 1. pick a number: explicit --number, else search DE national (no address req).
  let phoneNumber = wantedNumber;
  if (!phoneNumber) {
    const search = (await twilioRequest(
      `/2010-04-01/Accounts/${accountSid}/AvailablePhoneNumbers/DE/National.json?VoiceEnabled=true&ExcludeAllAddressRequired=true&PageSize=5`
    )) as { available_phone_numbers?: { phone_number: string }[] };
    phoneNumber = search.available_phone_numbers?.[0]?.phone_number;
    if (!phoneNumber) throw new Error('no available DE national number found');
  }
  console.log(`Number: ${phoneNumber}${dryRun ? ' (dry-run: not buying)' : ''}`);
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

  // 4. register at xAI; the dispatch signing secret is returned EXACTLY ONCE.
  const webhookUrl = `${appUrl}/api/hooks/voice?channel=${channelId}`;
  const res = await fetch(`${XAI_BASE}/v2/phone-numbers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${xaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: 'byo_trunk',
      name,
      phone_number: bought.phone_number,
      webhook: { url: webhookUrl },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `xAI phone-number registration → ${res.status}: ${(await res.text()).slice(0, 300)}`
    );
  }
  const registered = (await res.json()) as { id?: string; dispatch_signing_secret?: string };
  if (!registered.dispatch_signing_secret) {
    throw new Error('xAI did not return dispatch_signing_secret — check the API response shape');
  }

  // Encrypt FIRST — the plaintext secret exists only in this scope and is never
  // printed. If persisting fails, print the CIPHERTEXT for manual recovery: the
  // secret is returned exactly once by xAI and would otherwise force a full
  // deregister/re-register cycle of the number.
  const secretEncrypted = await encryptSecret(registered.dispatch_signing_secret, masterKey);
  const finalConfig = voiceChannelConfigSchema.parse({
    ...draftConfig,
    xaiPhoneNumberId: registered.id,
    dispatchSigningSecretEncrypted: secretEncrypted,
  });
  const { error: updateError } = await supabase
    .from('channels')
    .update({ config: finalConfig, is_active: true })
    .eq('id', channelId);
  if (updateError) {
    console.error('CHANNEL UPDATE FAILED — the one-time signing secret would be lost!');
    console.error('Manual recovery: set channels.config for channel', channelId, 'to include:');
    console.error(`  dispatchSigningSecretEncrypted: ${secretEncrypted}`);
    console.error(`  xaiPhoneNumberId: ${registered.id ?? '(unknown)'}`);
    console.error('…then set is_active=true. (Value above is libsodium ciphertext, safe to copy.)');
    throw new Error(`channel update failed: ${updateError.message}`);
  }

  console.log('Done.');
  console.log(`  Nummer:      ${bought.phone_number}`);
  console.log(`  Channel:     ${channelId}`);
  console.log(`  Webhook-URL: ${webhookUrl}`);
  console.log('  Kunde: Rufumleitung der bestehenden Nummer auf die Twilio-Nummer einrichten.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
