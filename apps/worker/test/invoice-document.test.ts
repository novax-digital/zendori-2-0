import { describe, expect, it } from 'vitest';
import { createLogger, type SupabaseClient } from '@zendori/core';
import type { SendEmailParams } from '@zendori/channels';
import {
  INVOICE_DOCUMENT_RETRY_DELAYS_MS,
  isInvoiceDocumentDue,
  processInvoiceDocument,
  type InvoiceDocumentDeps,
} from '../src/billing/invoice-document.js';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Phase 15b: the worker finishes an issued invoice — PDF into storage, then the
// mail with the PDF attached. Pins that each step happens once, that a failure
// is retried on the schedule and then shown as failed, and that the mail never
// goes out without its PDF.

const ID = '11111111-1111-4111-8111-111111111111';
const ORIGINAL_ID = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-12-01T08:00:00Z');
const logger = createLogger('test', 'silent');

function invoiceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ID,
    org_id: ORG,
    kind: 'invoice',
    number: 'ZD-2026-0001',
    period: '2026-11',
    issue_date: '2026-12-01',
    due_date: '2026-12-15',
    seller: { legalName: 'Novax Digital GmbH', email: 'info@zendori.ai', iban: 'DE02' },
    recipient: {
      legalName: 'Muster GmbH',
      addressLine1: 'Hauptstraße 1',
      postalCode: '10115',
      city: 'Berlin',
      country: 'DE',
    },
    lines: [{ label: 'WhatsApp (1×)', amountCents: 1500 }],
    tax_mode: 'de_vat',
    tax_percent: 19,
    net_cents: 1500,
    tax_cents: 285,
    gross_cents: 1785,
    cancels_invoice_id: null,
    cancelled_by_invoice_id: null,
    payment_status: 'open',
    paid_at: null,
    paid_via: null,
    paid_note: null,
    pdf_state: 'pending',
    pdf_path: null,
    pdf_attempts: 0,
    pdf_error: null,
    mail_state: 'pending',
    mail_to: 'rechnung@example.com',
    mail_sent_at: null,
    mail_attempts: 0,
    mail_error: null,
    next_attempt_at: null,
    created_at: '2026-12-01T07:59:00Z',
    ...overrides,
  };
}

interface World {
  db: MemoryDb;
  deps: InvoiceDocumentDeps;
  files: Map<string, Buffer>;
  sent: SendEmailParams[];
  rendered: { number: string; cancelsNumber: string | null | undefined }[];
  clock: { now: number };
  row(id?: string): Record<string, unknown>;
}

function world(
  options: {
    rows?: Record<string, unknown>[];
    from?: string | undefined;
    failRender?: () => boolean;
    failUpload?: () => boolean;
    failSend?: () => boolean;
  } = {}
): World {
  const db = createMemoryDb({ billing_invoices: options.rows ?? [invoiceRow()] });
  const files = new Map<string, Buffer>();
  const sent: SendEmailParams[] = [];
  const rendered: World['rendered'] = [];
  const clock = { now: NOW };
  const storage = {
    from: (bucket: string) => ({
      upload: async (path: string, body: Buffer) => {
        if (options.failUpload?.()) return { error: { message: 'storage down' } };
        files.set(`${bucket}/${path}`, body);
        return { error: null };
      },
      download: async (path: string) => {
        const body = files.get(`${bucket}/${path}`);
        return body
          ? { data: { arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }, error: null }
          : { data: null, error: { message: 'not found' } };
      },
    }),
  };
  const supabase = {
    from: (table: string) => db.client.from(table),
    storage,
  } as unknown as SupabaseClient;
  return {
    db,
    files,
    sent,
    rendered,
    clock,
    deps: {
      supabase,
      logger,
      from: 'from' in options ? options.from : 'Zendori <rechnung@example.org>',
      appUrl: 'https://app.example.com',
      now: () => clock.now,
      render: async ({ invoice, cancelsNumber }) => {
        if (options.failRender?.()) throw new Error('render broke');
        rendered.push({ number: invoice.number, cancelsNumber });
        return Buffer.from(`%PDF-fake ${invoice.number}`);
      },
      send: async (params) => {
        if (options.failSend?.()) throw new Error('resend down for rechnung@example.com');
        sent.push(params);
      },
    },
    row: (id = ID) => db.rows('billing_invoices').find((r) => r.id === id)!,
  };
}

describe('processInvoiceDocument', () => {
  it('stores the PDF, then mails it to the billing address', async () => {
    const w = world();
    await processInvoiceDocument(w.deps, ID);

    const path = `invoices/${ID}/ZD-2026-0001.pdf`;
    expect(w.files.get(path)?.toString()).toBe('%PDF-fake ZD-2026-0001');
    expect(w.row()).toMatchObject({
      pdf_state: 'ready',
      pdf_path: `${ID}/ZD-2026-0001.pdf`,
      mail_state: 'sent',
      mail_sent_at: new Date(NOW).toISOString(),
      mail_error: null,
      next_attempt_at: null,
    });

    expect(w.sent).toHaveLength(1);
    const mail = w.sent[0]!;
    expect(mail.to).toBe('rechnung@example.com');
    expect(mail.replyTo).toBe('info@zendori.ai');
    expect(mail.subject).toBe('Ihre Rechnung ZD-2026-0001 für November 2026');
    expect(mail.text).toContain('17,85');
    expect(mail.text).toContain('15.12.2026');
    expect(mail.text).toContain(`https://app.example.com/settings/billing?org=${ORG}`);
    expect(mail.attachments).toEqual([
      {
        filename: 'Rechnung-ZD-2026-0001.pdf',
        content: Buffer.from('%PDF-fake ZD-2026-0001').toString('base64'),
        contentType: 'application/pdf',
      },
    ]);
  });

  it('does each step once — a second run has nothing to do', async () => {
    const w = world();
    await processInvoiceDocument(w.deps, ID);
    await processInvoiceDocument(w.deps, ID);
    expect(w.rendered).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
  });

  it('only renders when no mail is asked for', async () => {
    const w = world({ rows: [invoiceRow({ mail_state: 'none', mail_to: null })] });
    await processInvoiceDocument(w.deps, ID);
    expect(w.row().pdf_state).toBe('ready');
    expect(w.row().mail_state).toBe('none');
    expect(w.sent).toHaveLength(0);
    expect(w.row().next_attempt_at).toBeNull();
  });

  it('retries a failed PDF on the schedule and never mails without it', async () => {
    let broken = true;
    const w = world({ failRender: () => broken });
    await processInvoiceDocument(w.deps, ID);
    expect(w.row()).toMatchObject({ pdf_state: 'pending', pdf_attempts: 1, pdf_error: 'pdf_failed' });
    expect(w.row().next_attempt_at).toBe(
      new Date(NOW + INVOICE_DOCUMENT_RETRY_DELAYS_MS[0]!).toISOString()
    );
    expect(w.sent).toHaveLength(0);

    // not due yet: nothing happens
    await processInvoiceDocument(w.deps, ID);
    expect(w.row().pdf_attempts).toBe(1);

    broken = false;
    w.clock.now = NOW + INVOICE_DOCUMENT_RETRY_DELAYS_MS[0]!;
    await processInvoiceDocument(w.deps, ID);
    expect(w.row()).toMatchObject({ pdf_state: 'ready', pdf_error: null, mail_state: 'sent' });
    expect(w.sent).toHaveLength(1);
  });

  it('gives up on the PDF after the last retry — the mail stays unsent', async () => {
    const w = world({ failUpload: () => true });
    for (let attempt = 0; attempt <= INVOICE_DOCUMENT_RETRY_DELAYS_MS.length; attempt += 1) {
      await processInvoiceDocument(w.deps, ID);
      w.clock.now += 3 * 60 * 60_000;
    }
    expect(w.row()).toMatchObject({
      pdf_state: 'failed',
      pdf_attempts: INVOICE_DOCUMENT_RETRY_DELAYS_MS.length + 1,
      mail_state: 'pending',
      next_attempt_at: null,
    });
    expect(w.sent).toHaveLength(0);
    // failed for good: the scan leaves it alone until the operator asks again
    expect(
      isInvoiceDocumentDue({ pdf_state: 'failed', mail_state: 'pending', next_attempt_at: null }, NOW)
    ).toBe(false);
  });

  it('retries a failed mail with the stored PDF, without rendering again', async () => {
    let broken = true;
    const w = world({ failSend: () => broken });
    await processInvoiceDocument(w.deps, ID);
    expect(w.row()).toMatchObject({
      pdf_state: 'ready',
      mail_state: 'pending',
      mail_attempts: 1,
      // a fixed word — the provider's message (with the address) stays out of the row
      mail_error: 'send_failed',
    });

    broken = false;
    w.clock.now = NOW + INVOICE_DOCUMENT_RETRY_DELAYS_MS[0]!;
    await processInvoiceDocument(w.deps, ID);
    expect(w.rendered).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.attachments?.[0]?.content).toBe(
      Buffer.from('%PDF-fake ZD-2026-0001').toString('base64')
    );
    expect(w.row()).toMatchObject({ mail_state: 'sent', mail_error: null });
  });

  it('marks the mail failed at once without a sender or a recipient', async () => {
    const noSender = world({ from: undefined });
    await processInvoiceDocument(noSender.deps, ID);
    expect(noSender.row()).toMatchObject({
      pdf_state: 'ready',
      mail_state: 'failed',
      mail_error: 'not_configured',
    });

    const noRecipient = world({ rows: [invoiceRow({ mail_to: '  ' })] });
    await processInvoiceDocument(noRecipient.deps, ID);
    expect(noRecipient.row()).toMatchObject({ mail_state: 'failed', mail_error: 'no_recipient' });
    expect(noRecipient.sent).toHaveLength(0);
  });

  it('a cancellation names the invoice it cancels, on paper and in the mail', async () => {
    const w = world({
      rows: [
        invoiceRow({ id: ORIGINAL_ID, pdf_state: 'ready', mail_state: 'sent', payment_status: 'void' }),
        invoiceRow({
          kind: 'cancellation',
          number: 'ZD-2026-0002',
          due_date: null,
          cancels_invoice_id: ORIGINAL_ID,
          lines: [{ label: 'WhatsApp (1×)', amountCents: -1500 }],
          net_cents: -1500,
          tax_cents: -285,
          gross_cents: -1785,
          payment_status: 'void',
        }),
      ],
    });
    await processInvoiceDocument(w.deps, ID);
    expect(w.rendered).toEqual([{ number: 'ZD-2026-0002', cancelsNumber: 'ZD-2026-0001' }]);
    const mail = w.sent[0]!;
    expect(mail.subject).toBe('Stornorechnung ZD-2026-0002 zur Rechnung ZD-2026-0001');
    expect(mail.attachments?.[0]?.filename).toBe('Stornorechnung-ZD-2026-0002.pdf');
    expect(mail.text).not.toContain('überweisen');
    // the original is untouched
    expect(w.row(ORIGINAL_ID).mail_state).toBe('sent');
  });

  it('links nowhere when the organization is gone', async () => {
    const w = world({ rows: [invoiceRow({ org_id: null })] });
    await processInvoiceDocument(w.deps, ID);
    expect(w.sent[0]!.text).not.toContain('/settings/billing');
  });

  it('ignores an unknown invoice', async () => {
    const w = world();
    await processInvoiceDocument(w.deps, '99999999-9999-4999-8999-999999999999');
    expect(w.rendered).toHaveLength(0);
  });
});

describe('isInvoiceDocumentDue', () => {
  it('is due while a step is pending and its time has come', () => {
    const due = (row: { pdf_state: string; mail_state: string; next_attempt_at: string | null }) =>
      isInvoiceDocumentDue(row, NOW);
    expect(due({ pdf_state: 'pending', mail_state: 'none', next_attempt_at: null })).toBe(true);
    expect(due({ pdf_state: 'ready', mail_state: 'pending', next_attempt_at: null })).toBe(true);
    expect(due({ pdf_state: 'ready', mail_state: 'sent', next_attempt_at: null })).toBe(false);
    expect(due({ pdf_state: 'ready', mail_state: 'failed', next_attempt_at: null })).toBe(false);
    expect(
      due({ pdf_state: 'pending', mail_state: 'pending', next_attempt_at: new Date(NOW + 1).toISOString() })
    ).toBe(false);
    expect(
      due({ pdf_state: 'pending', mail_state: 'pending', next_attempt_at: new Date(NOW).toISOString() })
    ).toBe(true);
  });
});
