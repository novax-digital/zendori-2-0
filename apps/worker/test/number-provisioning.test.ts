import { describe, expect, it } from 'vitest';
import { decryptSecret, type PhoneNumberType } from '@zendori/core';
import {
  createTwilioNumbersApi,
  createXaiNumbersApi,
  TwilioApiError,
  type BoughtNumber,
  type TwilioNumbersApi,
  type XaiNumbersApi,
} from '../src/numbers/api.js';
import {
  describeProvisionError,
  provisionAndRecord,
  purchaseFriendlyName,
  resolveProvisionConfig,
  type ProvisionConfig,
  type ProvisionRow,
  type ProvisionRowPatch,
  type ProvisionStore,
  type VoiceChannelRecord,
} from '../src/numbers/provision.js';

// Automatic number provisioning (0033): resumable steps against in-memory
// fakes — purchase idempotency, area-code search, channel reuse, xAI
// re-registration, config errors and secret redaction.

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const ROW_ID = '00000000-0000-4000-8000-0000000000aa';
const ORG_ID = '00000000-0000-4000-8000-0000000000bb';
const SECRET = 'whsec_one_time_super_secret';

const CONFIG: ProvisionConfig = {
  accountSid: 'AC123',
  authToken: 'tok',
  trunkSid: 'TK1',
  bundleSid: 'BU_LOCAL',
  addressSidOverride: undefined,
  xaiApiKey: 'xai-key',
  appUrl: 'https://app.zendori.ai',
  masterKey: MASTER_KEY,
};

function baseRow(overrides: Partial<ProvisionRow> = {}): ProvisionRow {
  return {
    id: ROW_ID,
    org_id: ORG_ID,
    number_type: 'local',
    e164: null,
    twilio_phone_number_sid: null,
    twilio_trunk_sid: null,
    xai_phone_number_id: null,
    channel_id: null,
    channel_name: null,
    area_code: null,
    ...overrides,
  };
}

class FakeStore implements ProvisionStore {
  row: ProvisionRow & ProvisionRowPatch;
  channels = new Map<string, VoiceChannelRecord>();
  quota: { limit: number | null; count: number } = { limit: null, count: 0 };
  inserts = 0;
  activateError: Error | null = null;

  constructor(row: ProvisionRow) {
    this.row = { ...row };
  }
  voiceQuota() {
    return Promise.resolve(this.quota);
  }
  orgName() {
    return Promise.resolve('Alltro GmbH');
  }
  updateRow(_id: string, patch: ProvisionRowPatch) {
    this.row = { ...this.row, ...patch };
    return Promise.resolve();
  }
  findVoiceChannelByNumber(_orgId: string, e164: string) {
    const match = [...this.channels.values()].find((c) => c.config.phoneNumber === e164);
    return Promise.resolve(match ?? null);
  }
  getChannel(id: string) {
    return Promise.resolve(this.channels.get(id) ?? null);
  }
  insertChannel(_orgId: string, name: string, config: Record<string, unknown>) {
    this.inserts += 1;
    const id = `ch-${this.inserts}`;
    this.channels.set(id, { id, name, isActive: false, config });
    return Promise.resolve(id);
  }
  activateChannel(id: string, config: Record<string, unknown>) {
    if (this.activateError) return Promise.reject(this.activateError);
    const channel = this.channels.get(id);
    if (channel) this.channels.set(id, { ...channel, isActive: true, config });
    return Promise.resolve();
  }
}

class FakeTwilio implements TwilioNumbersApi {
  incoming: (BoughtNumber & { friendlyName: string })[] = [];
  available = ['+4951116651692', '+4951116651659'];
  purchases: Parameters<TwilioNumbersApi['purchase']>[0][] = [];
  searches: { type: PhoneNumberType; areaCode?: string }[] = [];

  findIncomingByFriendlyName(friendlyName: string) {
    const match = this.incoming.find((n) => n.friendlyName === friendlyName);
    return Promise.resolve(match ? { sid: match.sid, phoneNumber: match.phoneNumber } : null);
  }
  searchAvailable(type: PhoneNumberType, options: { areaCode?: string }) {
    this.searches.push({ type, ...options });
    const prefix = options.areaCode ? `+49${options.areaCode}` : '+49';
    return Promise.resolve(this.available.filter((n) => n.startsWith(prefix)));
  }
  purchase(params: Parameters<TwilioNumbersApi['purchase']>[0]) {
    this.purchases.push(params);
    const bought = { sid: `PN${this.purchases.length}`, phoneNumber: params.phoneNumber };
    this.incoming.push({ ...bought, friendlyName: params.friendlyName });
    return Promise.resolve(bought);
  }
  addressSidForBundle() {
    return Promise.resolve('AD_HANNOVER');
  }
}

class FakeXai implements XaiNumbersApi {
  registered = new Map<string, string>();
  removed: string[] = [];
  registrations: { name: string; phoneNumber: string; webhookUrl: string }[] = [];

  findByNumber(e164: string) {
    return Promise.resolve(this.registered.get(e164) ?? null);
  }
  remove(id: string) {
    this.removed.push(id);
    for (const [number, existing] of this.registered) {
      if (existing === id) this.registered.delete(number);
    }
    return Promise.resolve();
  }
  register(params: { name: string; phoneNumber: string; webhookUrl: string }) {
    this.registrations.push(params);
    const id = `xai-${this.registrations.length}`;
    this.registered.set(params.phoneNumber, id);
    return Promise.resolve({ id, secret: SECRET });
  }
}

function setup(row: ProvisionRow = baseRow()) {
  const store = new FakeStore(row);
  const twilio = new FakeTwilio();
  const xai = new FakeXai();
  return { store, twilio, xai, deps: { store, twilio, xai, config: CONFIG } };
}

describe('provisionAndRecord', () => {
  it('buys, creates the channel, registers at xAI and activates (happy path)', async () => {
    const { store, twilio, xai, deps } = setup(baseRow({ area_code: '511' }));
    const outcome = await provisionAndRecord(store.row, deps);

    expect(outcome.ok).toBe(true);
    expect(twilio.searches).toEqual([{ type: 'local', areaCode: '511' }]);
    expect(twilio.purchases).toEqual([
      {
        phoneNumber: '+4951116651692',
        bundleSid: 'BU_LOCAL',
        trunkSid: 'TK1',
        friendlyName: purchaseFriendlyName(ROW_ID),
        addressSid: 'AD_HANNOVER',
      },
    ]);
    expect(store.row).toMatchObject({
      status: 'active',
      e164: '+4951116651692',
      twilio_phone_number_sid: 'PN1',
      twilio_trunk_sid: 'TK1',
      channel_id: 'ch-1',
      xai_phone_number_id: 'xai-1',
      provision_error: null,
      provision_started_at: null,
    });
    const channel = store.channels.get('ch-1');
    expect(channel?.name).toBe('Telefon Alltro GmbH');
    expect(channel?.isActive).toBe(true);
    expect(xai.registrations[0]?.webhookUrl).toBe(
      'https://app.zendori.ai/api/hooks/voice?channel=ch-1'
    );
    const encrypted = channel?.config.dispatchSigningSecretEncrypted as string;
    expect(encrypted).not.toContain(SECRET);
    expect(await decryptSecret(encrypted, MASTER_KEY)).toBe(SECRET);
  });

  it('uses the admin channel name and no AddressSid for mobile numbers', async () => {
    const { store, twilio, deps } = setup(
      baseRow({ number_type: 'mobile', channel_name: 'Hotline Alltro' })
    );
    twilio.available = ['+4915112345678'];
    await provisionAndRecord(store.row, deps);
    expect(twilio.purchases[0]?.addressSid).toBeUndefined();
    expect(store.channels.get('ch-1')?.name).toBe('Hotline Alltro');
  });

  it('resumes after a crash between purchase and persist without buying twice', async () => {
    const { store, twilio, deps } = setup();
    twilio.incoming.push({
      sid: 'PN_EARLIER',
      phoneNumber: '+4951116651111',
      friendlyName: purchaseFriendlyName(ROW_ID),
    });
    const outcome = await provisionAndRecord(store.row, deps);
    expect(outcome.ok).toBe(true);
    expect(twilio.purchases).toHaveLength(0);
    expect(twilio.searches).toHaveLength(0);
    expect(store.row).toMatchObject({
      status: 'active',
      e164: '+4951116651111',
      twilio_phone_number_sid: 'PN_EARLIER',
    });
  });

  it('fails with a clear German message when no number matches the area code', async () => {
    const { store, twilio, deps } = setup(baseRow({ area_code: '89' }));
    const outcome = await provisionAndRecord(store.row, deps);
    expect(outcome.ok).toBe(false);
    expect(twilio.purchases).toHaveLength(0);
    expect(store.row.status).toBe('failed');
    expect(store.row.provision_error).toBe(
      'Keine freie Nummer mit Vorwahl 089 – Vorwahl leeren oder ändern und erneut versuchen.'
    );
    expect(store.row.provision_started_at).toBeNull();
  });

  it('checks the voice quota before buying', async () => {
    const { store, twilio, deps } = setup();
    store.quota = { limit: 1, count: 1 };
    const outcome = await provisionAndRecord(store.row, deps);
    expect(outcome.ok).toBe(false);
    expect(twilio.purchases).toHaveLength(0);
    expect(store.row.provision_error).toContain('Kontingent');
  });

  it('reuses an org voice channel that already carries the number', async () => {
    const { store, deps } = setup(
      baseRow({ e164: '+4951116651692', twilio_phone_number_sid: 'PN9', twilio_trunk_sid: 'TK1' })
    );
    store.channels.set('ch-existing', {
      id: 'ch-existing',
      name: 'Telefon Alltro',
      isActive: false,
      config: { type: 'voice', provider: 'xai', phoneNumber: '+4951116651692', dispatchSigningSecretEncrypted: 'pending' },
    });
    const outcome = await provisionAndRecord(store.row, deps);
    expect(outcome.ok).toBe(true);
    expect(store.inserts).toBe(0);
    expect(store.row.channel_id).toBe('ch-existing');
    expect(store.channels.get('ch-existing')?.isActive).toBe(true);
  });

  it('drops a stale xAI registration (secret lost) and registers fresh', async () => {
    const { store, xai, deps } = setup(
      baseRow({ e164: '+4951116651692', twilio_phone_number_sid: 'PN9', twilio_trunk_sid: 'TK1' })
    );
    xai.registered.set('+4951116651692', 'xai-stale');
    const outcome = await provisionAndRecord(store.row, deps);
    expect(outcome.ok).toBe(true);
    expect(xai.removed).toEqual(['xai-stale']);
    expect(xai.registrations).toHaveLength(1);
  });

  it('skips the xAI step when the channel already holds its secret (resume after step d)', async () => {
    const { store, xai, deps } = setup(
      baseRow({
        e164: '+4951116651692',
        twilio_phone_number_sid: 'PN9',
        twilio_trunk_sid: 'TK1',
        channel_id: 'ch-done',
      })
    );
    store.channels.set('ch-done', {
      id: 'ch-done',
      name: 'Telefon Alltro',
      isActive: true,
      config: {
        type: 'voice',
        provider: 'xai',
        phoneNumber: '+4951116651692',
        xaiPhoneNumberId: 'xai-7',
        dispatchSigningSecretEncrypted: 'v1:abc:def',
      },
    });
    const outcome = await provisionAndRecord(store.row, deps);
    expect(outcome.ok).toBe(true);
    expect(xai.registrations).toHaveLength(0);
    expect(store.row).toMatchObject({ status: 'active', xai_phone_number_id: 'xai-7' });
  });

  it('never stores the one-time secret in the error text', async () => {
    const { store, deps } = setup();
    store.activateError = new Error(`update failed for value ${SECRET}`);
    const outcome = await provisionAndRecord(store.row, deps);
    expect(outcome.ok).toBe(false);
    expect(store.row.status).toBe('failed');
    expect(store.row.provision_error).not.toContain(SECRET);
    expect(store.row.provision_error).toContain('***');
    // the paid number + channel are kept for the resume
    expect(store.row.twilio_phone_number_sid).toBe('PN1');
    expect(store.row.channel_id).toBe('ch-1');
  });
});

describe('resolveProvisionConfig', () => {
  const full = {
    TWILIO_ACCOUNT_SID: 'AC1',
    TWILIO_AUTH_TOKEN: 'secret-token',
    TWILIO_VOICE_TRUNK_SID: 'TK1',
    TWILIO_BUNDLE_SID_LOCAL: 'BU_L',
    XAI_API_KEY: 'xai-secret',
    APP_URL: 'https://app.zendori.ai/',
    MASTER_ENCRYPTION_KEY: MASTER_KEY,
  };

  it('names missing variables (never values) for the admin UI', () => {
    const result = resolveProvisionConfig(
      { TWILIO_AUTH_TOKEN: 'secret-token', APP_URL: 'https://x.de' },
      baseRow({ number_type: 'mobile' })
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const name of [
        'TWILIO_ACCOUNT_SID',
        'TWILIO_VOICE_TRUNK_SID',
        'TWILIO_BUNDLE_SID_MOBILE',
        'XAI_API_KEY',
        'MASTER_ENCRYPTION_KEY',
      ]) {
        expect(result.error).toContain(name);
      }
      expect(result.error).not.toContain('secret-token');
    }
  });

  it('requires an https APP_URL and strips the trailing slash', () => {
    const insecure = resolveProvisionConfig({ ...full, APP_URL: 'http://localhost:3000' }, baseRow());
    expect(insecure.ok).toBe(false);
    const ok = resolveProvisionConfig(full, baseRow());
    expect(ok.ok && ok.config.appUrl).toBe('https://app.zendori.ai');
    expect(ok.ok && ok.config.bundleSid).toBe('BU_L');
  });

  it('falls back to the legacy bundle and needs none once the number is bought', () => {
    const { TWILIO_BUNDLE_SID_LOCAL: _unused, ...withoutTyped } = full;
    void _unused;
    const legacy = resolveProvisionConfig({ ...withoutTyped, TWILIO_BUNDLE_SID: 'BU_OLD' }, baseRow());
    expect(legacy.ok && legacy.config.bundleSid).toBe('BU_OLD');
    const bought = resolveProvisionConfig(
      withoutTyped,
      baseRow({ twilio_phone_number_sid: 'PN1', twilio_trunk_sid: 'TK_OLD' })
    );
    expect(bought.ok && bought.config.trunkSid).toBe('TK_OLD');
  });
});

describe('provider clients', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('narrows the Twilio search with Contains and enforces the prefix client-side', async () => {
    const urls: string[] = [];
    const api = createTwilioNumbersApi({
      accountSid: 'AC1',
      authToken: 'tok',
      fetchImpl: (input) => {
        urls.push(String(input));
        return Promise.resolve(
          jsonResponse({
            available_phone_numbers: [
              { phone_number: '+4930511000' }, // contains 511, wrong area
              { phone_number: '+4951116651692' },
            ],
          })
        );
      },
    });
    const numbers = await api.searchAvailable('local', { areaCode: '511' });
    expect(numbers).toEqual(['+4951116651692']);
    const url = new URL(urls[0] ?? '');
    expect(url.pathname).toBe('/2010-04-01/Accounts/AC1/AvailablePhoneNumbers/DE/Local.json');
    expect(url.searchParams.get('Contains')).toBe('+49511');
    expect(url.searchParams.get('ExcludeAllAddressRequired')).toBeNull();
  });

  it('maps Twilio error bodies to TwilioApiError with code', async () => {
    const api = createTwilioNumbersApi({
      accountSid: 'AC1',
      authToken: 'tok',
      fetchImpl: () =>
        Promise.resolve(
          jsonResponse({ code: 21631, message: 'Phone Number Requires an Address' }, 400)
        ),
    });
    const error = await api
      .purchase({ phoneNumber: '+495111', bundleSid: 'BU', trunkSid: 'TK', friendlyName: 'x' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TwilioApiError);
    expect(describeProvisionError(error)).toBe(
      'Twilio (Code 21631) – Twilio-Kauf: Phone Number Requires an Address'
    );
  });

  it('extracts the xAI signing secret and reports only field names when absent', async () => {
    const ok = createXaiNumbersApi({
      apiKey: 'k',
      fetchImpl: () =>
        Promise.resolve(jsonResponse({ phoneNumberId: 'pn_1', dispatchSigningSecret: SECRET })),
    });
    await expect(
      ok.register({ name: 'n', phoneNumber: '+49511', webhookUrl: 'https://x' })
    ).resolves.toEqual({ id: 'pn_1', secret: SECRET });

    const missing = createXaiNumbersApi({
      apiKey: 'k',
      fetchImpl: () => Promise.resolve(jsonResponse({ phoneNumberId: 'pn_1', token: 'tok_value' })),
    });
    const error = await missing
      .register({ name: 'n', phoneNumber: '+49511', webhookUrl: 'https://x' })
      .catch((e: unknown) => e);
    expect(String((error as Error).message)).toContain('phoneNumberId, token');
    expect(String((error as Error).message)).not.toContain('tok_value');
  });
});
