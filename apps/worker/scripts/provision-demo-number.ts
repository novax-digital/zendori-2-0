// Demo-Anruf (0032): one-time setup of the operator DEMO number.
//
// The demo number is NOT a tenant channel and NOT on the SIP trunk:
//   - Twilio: plain Programmable-Voice number. Caller id of the outbound demo
//     calls; its Voice URL plays a short static notice to people who call back
//     (/api/hooks/demo/inbound).
//   - xAI: registered (byo_trunk) with the webhook /api/hooks/demo/voice — the
//     target of the worker's <Dial><Sip>sip:{number}@sip.voice.x.ai> bridge.
// The xAI dispatch signing secret is returned exactly ONCE; it belongs into
// Vercel (DEMO_XAI_SIGNING_SECRET, Production). With --secret-out it is written
// to a file (mode 600) instead of the terminal.
//
// Usage (from apps/worker, .env at repo root loaded via --env-file):
//   npx tsx --env-file=../../.env scripts/provision-demo-number.ts \
//     --number +49… [--type local|mobile] [--reregister] [--secret-out <file>]
//   --number      the demo number (E.164). If it is not in the Twilio account
//                 yet it is BOUGHT (then --type is required for the bundle).
//   --reregister  delete an existing xAI registration of the number first
//                 (the only way to get a fresh signing secret).
//
// Required env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, XAI_API_KEY, APP_URL
// (https — xAI stores the webhook URL fixed per number), and for a purchase
// TWILIO_BUNDLE_SID_LOCAL / _MOBILE.
import { writeFileSync } from 'node:fs';
import { addressSidForBundle } from '../src/numbers/twilio-address.js';

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

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/** Same tolerant secret lookup as provision-voice-number.ts (camelCase live API). */
function findSigningSecret(node: unknown): string | null {
  const found: { key: string; value: string }[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        if (typeof v === 'string' && v && /secret/i.test(k)) found.push({ key: k, value: v });
        else walk(v);
      }
    }
  };
  walk(node);
  return (found.find((c) => /signing|dispatch/i.test(c.key)) ?? found[0])?.value ?? null;
}

async function main(): Promise<void> {
  const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
  const authToken = requireEnv('TWILIO_AUTH_TOKEN');
  const xaiKey = requireEnv('XAI_API_KEY');
  const appUrl = requireEnv('APP_URL').replace(/\/+$/, '');
  if (!appUrl.startsWith('https://')) {
    throw new Error(`APP_URL must be the https production URL (got ${appUrl}) — override it inline`);
  }
  const number = arg('--number');
  if (!number || !/^\+[1-9]\d{6,14}$/.test(number)) {
    console.error('Usage: provision-demo-number.ts --number +49… [--type local|mobile] [--reregister] [--secret-out <file>]');
    process.exit(1);
  }
  const auth = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
  const twilio = async (path: string, params?: URLSearchParams): Promise<Record<string, unknown>> => {
    const res = await fetch(`${TWILIO_BASE}${path}`, {
      method: params ? 'POST' : 'GET',
      headers: {
        Authorization: auth,
        ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(params ? { body: params.toString() } : {}),
    });
    if (!res.ok) throw new Error(`Twilio ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as Record<string, unknown>;
  };

  const voiceUrl = `${appUrl}/api/hooks/demo/inbound`;
  const webhookUrl = `${appUrl}/api/hooks/demo/voice`;

  // 1. Twilio: find or buy the number; Voice URL → static callback notice.
  const owned = await twilio(
    `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(number)}`
  );
  const ownedList = (owned.incoming_phone_numbers ?? []) as Record<string, unknown>[];
  const existing = ownedList[0];
  if (existing) {
    if (typeof existing.trunk_sid === 'string' && existing.trunk_sid) {
      throw new Error(
        `${number} hängt am SIP-Trunk ${existing.trunk_sid} (vermutlich ein Kunden-Voice-Kanal) — bitte eine eigene Demo-Nummer verwenden.`
      );
    }
    await twilio(
      `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${String(existing.sid)}.json`,
      new URLSearchParams({ VoiceUrl: voiceUrl, VoiceMethod: 'POST', FriendlyName: 'Zendori Demo' })
    );
    console.log(`Twilio: ${number} vorhanden, Voice-URL gesetzt.`);
  } else {
    const type = arg('--type');
    if (type !== 'local' && type !== 'mobile') {
      throw new Error(`${number} ist nicht im Twilio-Account — zum Kaufen --type local|mobile angeben.`);
    }
    const bundleSid = requireEnv(type === 'local' ? 'TWILIO_BUNDLE_SID_LOCAL' : 'TWILIO_BUNDLE_SID_MOBILE');
    const purchase = new URLSearchParams({
      PhoneNumber: number,
      BundleSid: bundleSid,
      VoiceUrl: voiceUrl,
      VoiceMethod: 'POST',
      FriendlyName: 'Zendori Demo',
    });
    if (type === 'local') {
      purchase.set('AddressSid', await addressSidForBundle(bundleSid, { accountSid, authToken }));
    }
    const bought = await twilio(`/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`, purchase);
    console.log(`Twilio: ${String(bought.phone_number)} gekauft (${String(bought.sid)}).`);
  }

  // 2. xAI: (re-)register with the demo webhook.
  const listRes = await fetch(`${XAI_BASE}/v2/phone-numbers`, {
    headers: { Authorization: `Bearer ${xaiKey}` },
  });
  if (listRes.ok) {
    const listRaw = (await listRes.json()) as Record<string, unknown>;
    const numbers = (listRaw.phoneNumbers ?? listRaw.phone_numbers ?? []) as Record<string, unknown>[];
    const registered = numbers.find((n) => n.phoneNumber === number || n.phone_number === number);
    const registeredId = registered
      ? firstString(registered, ['phoneNumberId', 'id', 'phone_number_id'])
      : undefined;
    if (registeredId) {
      if (!process.argv.includes('--reregister')) {
        throw new Error(
          `${number} ist bei xAI bereits registriert (${registeredId}). Mit --reregister neu registrieren (neues Secret → Vercel aktualisieren).`
        );
      }
      const delRes = await fetch(`${XAI_BASE}/v2/phone-numbers/${registeredId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${xaiKey}` },
      });
      if (!delRes.ok) throw new Error(`xAI deregistration → ${delRes.status}`);
      console.log('xAI: alte Registrierung gelöscht.');
    }
  }
  const regRes = await fetch(`${XAI_BASE}/v2/phone-numbers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${xaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      origin: 'byo_trunk',
      name: 'Zendori Demo',
      phone_number: number,
      webhook: { url: webhookUrl },
    }),
  });
  if (!regRes.ok) {
    throw new Error(`xAI phone-number registration → ${regRes.status}: ${(await regRes.text()).slice(0, 300)}`);
  }
  const secret = findSigningSecret(await regRes.json());
  if (!secret) throw new Error('xAI hat kein Signing-Secret zurückgegeben — Registrierung prüfen.');

  const secretOut = arg('--secret-out');
  console.log('');
  console.log('Fertig. Jetzt eintragen:');
  console.log(`  Worker (.env auf dem VPS):  DEMO_VOICE_NUMBER=${number}`);
  if (secretOut) {
    writeFileSync(secretOut, `${secret}\n`, { mode: 0o600 });
    console.log(`  Vercel (Production):        DEMO_XAI_SIGNING_SECRET=<Inhalt von ${secretOut}>`);
  } else {
    console.log(`  Vercel (Production):        DEMO_XAI_SIGNING_SECRET=${secret}`);
  }
  console.log(`  xAI-Webhook:                ${webhookUrl}`);
  console.log(`  Rückruf-Ansage (Twilio):    ${voiceUrl}`);
  console.log('  Das Secret wird nur dieses eine Mal angezeigt.');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
