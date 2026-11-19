import { z } from 'zod';
import type { PhoneNumberType } from '@zendori/core';
import { addressSidForBundle } from './twilio-address.js';

// Provider clients for number provisioning (0033): Twilio (search / buy /
// idempotency lookup / bundle address) and xAI (phone-number registry). Thin,
// fetch-based, zod-parsed at the boundary; fetch + base URLs are injectable so
// the provisioner is unit-testable without network.

// --- errors ------------------------------------------------------------------------

/** Twilio REST error (body: { code, message, more_info }). Never carries credentials. */
export class TwilioApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  constructor(status: number, code: number | null, message: string) {
    super(message);
    this.name = 'TwilioApiError';
    this.status = status;
    this.code = code;
  }
}

/** xAI REST error (status + truncated body). */
export class XaiApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'XaiApiError';
    this.status = status;
  }
}

const twilioErrorBodySchema = z.object({
  code: z.number().nullish(),
  message: z.string().nullish(),
});

async function twilioError(res: Response, what: string): Promise<TwilioApiError> {
  const text = await res.text();
  let code: number | null = null;
  let message = text.slice(0, 300);
  try {
    const parsed = twilioErrorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      code = parsed.data.code ?? null;
      if (parsed.data.message) message = parsed.data.message;
    }
  } catch {
    // non-JSON body: keep the raw (truncated) text
  }
  return new TwilioApiError(res.status, code, `${what}: ${message}`);
}

// --- Twilio ------------------------------------------------------------------------

/** DE number types → Twilio search endpoint (each type has its own bundle). */
export const TWILIO_SEARCH_ENDPOINTS: Record<PhoneNumberType, string> = {
  local: 'Local',
  mobile: 'Mobile',
  national: 'National',
};

export interface BoughtNumber {
  sid: string;
  phoneNumber: string;
}

export interface TwilioNumbersApi {
  /** Exact FriendlyName match among the account's numbers (purchase idempotency). */
  findIncomingByFriendlyName(friendlyName: string): Promise<BoughtNumber | null>;
  /** Available voice-enabled DE numbers, optionally restricted to +49<areaCode>… */
  searchAvailable(type: PhoneNumberType, options: { areaCode?: string }): Promise<string[]>;
  purchase(params: {
    phoneNumber: string;
    bundleSid: string;
    trunkSid: string;
    addressSid?: string;
    friendlyName: string;
  }): Promise<BoughtNumber>;
  /** AddressSid proven in the bundle (local numbers, Twilio 21631). */
  addressSidForBundle(bundleSid: string): Promise<string>;
}

const incomingListSchema = z.object({
  incoming_phone_numbers: z.array(
    z.object({ sid: z.string(), phone_number: z.string(), friendly_name: z.string().nullish() })
  ),
});
const availableListSchema = z.object({
  available_phone_numbers: z.array(z.object({ phone_number: z.string() })),
});
const purchasedSchema = z.object({ sid: z.string(), phone_number: z.string() });

export interface TwilioClientOptions {
  accountSid: string;
  authToken: string;
  addressSidOverride?: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  numbersBase?: string;
}

export function createTwilioNumbersApi(options: TwilioClientOptions): TwilioNumbersApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = (options.apiBase ?? 'https://api.twilio.com').replace(/\/+$/, '');
  const account = `${apiBase}/2010-04-01/Accounts/${options.accountSid}`;
  const auth = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`;

  async function get(url: string, what: string): Promise<unknown> {
    const res = await fetchImpl(url, { headers: { Authorization: auth } });
    if (!res.ok) throw await twilioError(res, what);
    return res.json();
  }

  return {
    async findIncomingByFriendlyName(friendlyName) {
      const query = new URLSearchParams({ FriendlyName: friendlyName, PageSize: '20' });
      const data = incomingListSchema.parse(
        await get(`${account}/IncomingPhoneNumbers.json?${query.toString()}`, 'Twilio-Nummernliste')
      );
      const match = data.incoming_phone_numbers.find((n) => n.friendly_name === friendlyName);
      return match ? { sid: match.sid, phoneNumber: match.phone_number } : null;
    },

    async searchAvailable(type, { areaCode }) {
      const query = new URLSearchParams({ VoiceEnabled: 'true', PageSize: '20' });
      // Local numbers carry a per-city address requirement (solved via the
      // bundle's AddressSid) — only national/mobile exclude address-bound ones.
      if (type !== 'local') query.set('ExcludeAllAddressRequired', 'true');
      // Live-verified 2026-11-13: Contains=+49511 returns only +49511… numbers.
      if (areaCode) query.set('Contains', `+49${areaCode}`);
      const data = availableListSchema.parse(
        await get(
          `${account}/AvailablePhoneNumbers/DE/${TWILIO_SEARCH_ENDPOINTS[type]}.json?${query.toString()}`,
          'Twilio-Nummernsuche'
        )
      );
      const numbers = data.available_phone_numbers.map((n) => n.phone_number);
      // Contains is a pattern match, not a prefix match — enforce the prefix.
      return areaCode ? numbers.filter((n) => n.startsWith(`+49${areaCode}`)) : numbers;
    },

    async purchase({ phoneNumber, bundleSid, trunkSid, addressSid, friendlyName }) {
      // TrunkSid attaches the number to the Elastic SIP trunk (voice URLs ignored).
      const body = new URLSearchParams({
        PhoneNumber: phoneNumber,
        BundleSid: bundleSid,
        TrunkSid: trunkSid,
        FriendlyName: friendlyName,
      });
      if (addressSid) body.set('AddressSid', addressSid);
      const res = await fetchImpl(`${account}/IncomingPhoneNumbers.json`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) throw await twilioError(res, 'Twilio-Kauf');
      const bought = purchasedSchema.parse(await res.json());
      return { sid: bought.sid, phoneNumber: bought.phone_number };
    },

    addressSidForBundle(bundleSid) {
      return addressSidForBundle(
        bundleSid,
        { accountSid: options.accountSid, authToken: options.authToken },
        {
          ...(options.addressSidOverride ? { override: options.addressSidOverride } : {}),
          fetchImpl,
          ...(options.numbersBase ? { numbersBase: options.numbersBase } : {}),
        }
      );
    },
  };
}

// --- xAI -----------------------------------------------------------------------------

/** First non-empty string among the given keys (snake_case docs vs camelCase live API). */
export function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
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

export function findSigningSecret(response: unknown): { key: string; value: string } | null {
  const candidates: { key: string; value: string }[] = [];
  collectSecrets(response, candidates);
  return candidates.find((c) => /signing|dispatch/i.test(c.key)) ?? candidates[0] ?? null;
}

export interface XaiRegistration {
  id: string | undefined;
  /** The ONE-TIME dispatch signing secret — encrypt immediately, never log. */
  secret: string;
}

export interface XaiNumbersApi {
  /** Registration id of a number, or null when it is not registered. */
  findByNumber(e164: string): Promise<string | null>;
  remove(id: string): Promise<void>;
  register(params: { name: string; phoneNumber: string; webhookUrl: string }): Promise<XaiRegistration>;
}

const looseObjectSchema = z.record(z.string(), z.unknown());

export interface XaiClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

export function createXaiNumbersApi(options: XaiClientOptions): XaiNumbersApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.apiBase ?? 'https://api.x.ai').replace(/\/+$/, '');
  const auth = `Bearer ${options.apiKey}`;

  async function fail(res: Response, what: string): Promise<XaiApiError> {
    return new XaiApiError(res.status, `${what} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  return {
    async findByNumber(e164) {
      const res = await fetchImpl(`${base}/v2/phone-numbers`, { headers: { Authorization: auth } });
      if (!res.ok) throw await fail(res, 'xAI-Nummernliste');
      const data = looseObjectSchema.parse(await res.json());
      const list = z
        .array(looseObjectSchema)
        .catch([])
        .parse(data.phoneNumbers ?? data.phone_numbers ?? []);
      const existing = list.find((n) => n.phoneNumber === e164 || n.phone_number === e164);
      return existing ? (firstString(existing, ['phoneNumberId', 'id', 'phone_number_id']) ?? null) : null;
    },

    async remove(id) {
      const res = await fetchImpl(`${base}/v2/phone-numbers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!res.ok) throw await fail(res, 'xAI-Deregistrierung');
    },

    async register({ name, phoneNumber, webhookUrl }) {
      const res = await fetchImpl(`${base}/v2/phone-numbers`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          origin: 'byo_trunk',
          name,
          phone_number: phoneNumber,
          webhook: { url: webhookUrl },
        }),
      });
      if (!res.ok) throw await fail(res, 'xAI-Registrierung');
      const registered = looseObjectSchema.parse(await res.json());
      const secret = findSigningSecret(registered);
      if (!secret) {
        // Field NAMES only — never values (the response may carry other tokens).
        throw new XaiApiError(
          res.status,
          `xAI hat kein Signing-Secret zurückgegeben (Felder: ${Object.keys(registered).join(', ') || '—'})`
        );
      }
      return {
        id: firstString(registered, ['phoneNumberId', 'id', 'phone_number_id']),
        secret: secret.value,
      };
    },
  };
}
