import { describe, expect, it } from 'vitest';
import { createLogger } from '@zendori/core';
import type { SendEmailParams } from '@zendori/channels';
import { periodLabel, sendBillingSetupMail, type SetupMailDeps } from '../src/billing/setup-mail.js';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Migration 0044: the mail that asks a customer to set up billing. Pins who
// gets it, that it goes out once per request, that it waits for the Stripe
// sync, and that it is never sent for a customer that is not enabled.

const ORG = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-26T10:00:00Z');
const REQUESTED = new Date(NOW - 5_000).toISOString();
const logger = createLogger('test', 'silent');

const DETAILS = {
  org_id: ORG,
  legal_name: 'Muster GmbH',
  address_line1: 'Hauptstraße 1',
  address_line2: null,
  postal_code: '10115',
  city: 'Berlin',
  country: 'DE',
  vat_id: null,
  billing_email: 'rechnung@example.com',
};

function customerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    org_id: ORG,
    livemode: true,
    enabled: true,
    invoice_from: '2026-12',
    payment_method_id: null,
    sync_requested_at: null,
    sync_error: null,
    setup_mail_requested_at: REQUESTED,
    setup_mail_sent_at: null,
    setup_mail_error: null,
    ...overrides,
  };
}

const MEMBERS = [
  { org_id: ORG, user_id: 'u-owner', role: 'owner' },
  { org_id: ORG, user_id: 'u-admin', role: 'admin' },
  { org_id: ORG, user_id: 'u-agent', role: 'agent' },
];
const EMAILS: Record<string, string | null> = {
  'u-owner': 'inhaber@example.com',
  'u-admin': 'admin@example.com',
  'u-agent': 'agent@example.com',
};

interface World {
  db: MemoryDb;
  deps: SetupMailDeps;
  sent: SendEmailParams[];
  row(): Record<string, unknown>;
}

function world(
  options: {
    row?: Record<string, unknown>;
    details?: Record<string, unknown> | null;
    members?: Record<string, unknown>[];
    emails?: Record<string, string | null>;
    from?: string | undefined;
    livemode?: boolean;
    failSend?: (to: string) => boolean;
  } = {}
): World {
  const db = createMemoryDb({
    billing_stripe_customers: [options.row ?? customerRow()],
    billing_accounts: options.details === null ? [] : [options.details ?? DETAILS],
    organizations: [{ id: ORG, name: 'Muster GmbH' }],
    org_members: options.members ?? MEMBERS,
  });
  const sent: SendEmailParams[] = [];
  const emails = options.emails ?? EMAILS;
  return {
    db,
    sent,
    deps: {
      supabase: db.client,
      logger,
      stripe: { config: { secretKey: 'sk_test_x' }, livemode: options.livemode ?? true },
      from: 'from' in options ? options.from : 'Zendori <no-reply@example.com>',
      appUrl: 'https://app.example.com/',
      getUserEmail: async (userId) => emails[userId] ?? null,
      send: async (params) => {
        if (options.failSend?.(String(params.to))) throw new Error('resend down');
        sent.push(params);
      },
      now: () => NOW,
    },
    row: () => db.rows('billing_stripe_customers')[0]!,
  };
}

describe('billing setup mail', () => {
  it('goes to owners and admins, one mail each, with the link to the billing page', async () => {
    const w = world();
    const outcome = await sendBillingSetupMail(w.deps, ORG);

    expect(outcome).toEqual({ kind: 'sent', recipients: 2 });
    expect(w.sent.map((mail) => mail.to)).toEqual(['inhaber@example.com', 'admin@example.com']);
    const mail = w.sent[0]!;
    // details are on file, only the payment method is missing
    expect(mail.subject).toBe('Bitte Zahlungsart für Muster GmbH hinterlegen');
    expect(mail.text).toContain(`https://app.example.com/settings/billing?org=${ORG}`);
    expect(mail.text).toContain('Dezember 2026');
    expect(mail.html).toContain('erforderlich');

    expect(w.row().setup_mail_requested_at).toBeNull();
    expect(w.row().setup_mail_sent_at).toBe(new Date(NOW).toISOString());
    expect(w.row().setup_mail_error).toBeNull();
  });

  it('asks for both when billing details are missing too', async () => {
    const w = world({ details: null });
    await sendBillingSetupMail(w.deps, ORG);
    expect(w.sent[0]!.subject).toBe(
      'Bitte Rechnungsdaten und Zahlungsart für Muster GmbH hinterlegen'
    );
  });

  it('is sent once per request — a second run finds nothing to do', async () => {
    const w = world();
    await sendBillingSetupMail(w.deps, ORG);
    expect(await sendBillingSetupMail(w.deps, ORG)).toEqual({ kind: 'idle' });
    expect(w.sent).toHaveLength(2);
  });

  it('does nothing without a request', async () => {
    const w = world({ row: customerRow({ setup_mail_requested_at: null }) });
    expect(await sendBillingSetupMail(w.deps, ORG)).toEqual({ kind: 'idle' });
    expect(w.sent).toHaveLength(0);
  });

  it('waits while the Stripe sync is still pending and keeps the request', async () => {
    const w = world({ row: customerRow({ sync_requested_at: REQUESTED }) });
    expect(await sendBillingSetupMail(w.deps, ORG)).toEqual({ kind: 'idle' });
    expect(w.sent).toHaveLength(0);
    expect(w.row().setup_mail_requested_at).toBe(REQUESTED);
  });

  it('never mails a customer that is not enabled, even with a sync still open', async () => {
    const w = world({ row: customerRow({ enabled: false, sync_requested_at: REQUESTED }) });
    expect(await sendBillingSetupMail(w.deps, ORG)).toEqual({ kind: 'not_sent', reason: 'disabled' });
    expect(w.sent).toHaveLength(0);
    expect(w.row().setup_mail_requested_at).toBeNull();
    expect(w.row().setup_mail_error).toBe('disabled');
  });

  it('sends nothing when the Stripe sync failed for good, and says why', async () => {
    const w = world({ row: customerRow({ sync_error: 'stripe:401' }) });
    expect(await sendBillingSetupMail(w.deps, ORG)).toEqual({
      kind: 'not_sent',
      reason: 'sync_failed',
    });
    expect(w.sent).toHaveLength(0);
    expect(w.row().setup_mail_error).toBe('sync_failed');
  });

  it('sends nothing when everything is on file already — and that is no error', async () => {
    const w = world({ row: customerRow({ payment_method_id: 'pm_1' }) });
    expect(await sendBillingSetupMail(w.deps, ORG)).toEqual({ kind: 'not_sent', reason: 'complete' });
    expect(w.sent).toHaveLength(0);
    expect(w.row().setup_mail_error).toBeNull();
    expect(w.row().setup_mail_sent_at).toBeNull();
  });

  it('reports a missing sender and missing recipients to the operator', async () => {
    const noSender = world({ from: undefined });
    expect(await sendBillingSetupMail(noSender.deps, ORG)).toEqual({
      kind: 'not_sent',
      reason: 'not_configured',
    });
    expect(noSender.row().setup_mail_error).toBe('not_configured');

    const nobody = world({ members: [{ org_id: ORG, user_id: 'u-agent', role: 'agent' }] });
    expect(await sendBillingSetupMail(nobody.deps, ORG)).toEqual({
      kind: 'not_sent',
      reason: 'no_recipient',
    });

    const gone = world({ emails: { 'u-owner': null, 'u-admin': null } });
    expect(await sendBillingSetupMail(gone.deps, ORG)).toEqual({
      kind: 'not_sent',
      reason: 'no_recipient',
    });
  });

  it('writes one address only once when two members share it', async () => {
    const w = world({ emails: { 'u-owner': 'Chef@example.com', 'u-admin': 'chef@example.com' } });
    expect(await sendBillingSetupMail(w.deps, ORG)).toEqual({ kind: 'sent', recipients: 1 });
  });

  it('counts as sent when at least one mail went out; all failing is an error', async () => {
    const partial = world({ failSend: (to) => to === 'inhaber@example.com' });
    expect(await sendBillingSetupMail(partial.deps, ORG)).toEqual({ kind: 'sent', recipients: 1 });

    const none = world({ failSend: () => true });
    expect(await sendBillingSetupMail(none.deps, ORG)).toEqual({
      kind: 'not_sent',
      reason: 'send_failed',
    });
    expect(none.row().setup_mail_error).toBe('send_failed');
    expect(none.row().setup_mail_sent_at).toBeNull();
    // the request is used up: no automatic second try, the operator asks again
    expect(none.row().setup_mail_requested_at).toBeNull();
  });

  it('only touches the row of its own Stripe mode and marks the test mode', async () => {
    const live = world({ livemode: false });
    // the worker runs with a test key, the request sits on the live row
    expect(await sendBillingSetupMail(live.deps, ORG)).toEqual({ kind: 'idle' });
    expect(live.row().setup_mail_requested_at).toBe(REQUESTED);

    const test = world({ livemode: false, row: customerRow({ livemode: false }) });
    await sendBillingSetupMail(test.deps, ORG);
    expect(test.sent[0]!.subject).toMatch(/^\[Testmodus\] /);
    expect(test.sent[0]!.text).toContain('Testmodus');
  });

  it('names the first month in words', () => {
    expect(periodLabel('2026-12')).toBe('Dezember 2026');
    expect(periodLabel('2027-01')).toBe('Januar 2027');
    expect(periodLabel(null)).toBeNull();
    expect(periodLabel('2026-13')).toBeNull();
  });
});
