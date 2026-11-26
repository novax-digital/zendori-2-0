'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  billingDetailsErrorMessage,
  billingDetailsSchema,
  invoiceSellerSchema,
  isInvoiceNumberFormat,
} from '@zendori/core';
import { requirePlatformAdmin } from '@/lib/admin-auth';
import { billingDetailsFromForm, saveBillingDetailsRow } from '@/lib/billing-account';
import {
  cancelInvoice,
  confirmAccountVatId,
  issueInvoiceForMonth,
  requestInvoiceMail,
  saveSellerSettings,
  setInvoicePaid,
} from '@/lib/invoices';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';

// Own invoices, operator side (Phase 15b): the seller's details, issuing an
// invoice for a customer and a month, payment state, sending again, cancelling.
// Platform admin only; everything is written with the service role.

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

type Message = { error?: string; notice?: string };

/** Where an action returns to: only paths inside the admin area, never an open redirect. */
function backUrl(formData: FormData, fallback: string, message: Message): string {
  const raw = textField(formData.get('returnTo'));
  const base = /^\/admin\/[A-Za-z0-9\-_/]*(\?[A-Za-z0-9\-_=&%.]*)?$/.test(raw) ? raw : fallback;
  const [path, query] = base.split('?') as [string, string | undefined];
  const params = new URLSearchParams(query ?? '');
  params.delete('error');
  params.delete('notice');
  if (message.error) params.set('error', message.error);
  if (message.notice) params.set('notice', message.notice);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

const NO_SERVICE_ROLE = 'Service-Role ist serverseitig nicht konfiguriert.';
const INVOICES = '/admin/invoices';

function revalidateInvoices(orgId?: string | null): void {
  revalidatePath(INVOICES);
  if (orgId) {
    revalidatePath(`/admin/billing/${orgId}`);
    revalidatePath('/settings/billing');
  }
}

// --- the seller -----------------------------------------------------------------

export async function saveSeller(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const target = `${INVOICES}/seller`;
  const fail = (error: string): never => redirect(backUrl(formData, target, { error }));

  const seller = invoiceSellerSchema.safeParse({
    legalName: textField(formData.get('legalName')),
    addressLine1: textField(formData.get('addressLine1')),
    addressLine2: textField(formData.get('addressLine2')),
    postalCode: textField(formData.get('postalCode')),
    city: textField(formData.get('city')),
    country: textField(formData.get('country')) || 'DE',
    vatId: textField(formData.get('vatId')),
    taxNumber: textField(formData.get('taxNumber')),
    registerCourt: textField(formData.get('registerCourt')),
    registerNumber: textField(formData.get('registerNumber')),
    managingDirectors: textField(formData.get('managingDirectors')),
    email: textField(formData.get('email')),
    phone: textField(formData.get('phone')),
    website: textField(formData.get('website')),
    bankName: textField(formData.get('bankName')),
    // an IBAN is typed with or without spaces; stored in groups of four
    iban: textField(formData.get('iban'))
      .replace(/\s+/g, '')
      .toUpperCase()
      .replace(/(.{4})(?=.)/g, '$1 '),
    bic: textField(formData.get('bic')).toUpperCase(),
    footerNote: textField(formData.get('footerNote')),
  });
  if (!seller.success) return fail('Bitte prüfe die Angaben (ein Feld ist zu lang).');
  if (seller.data.email !== '' && !z.email().safeParse(seller.data.email).success) {
    return fail('Die E-Mail-Adresse ist nicht gültig.');
  }
  if (seller.data.iban !== '' && !/^[A-Z]{2}\d{2}[A-Z0-9 ]{11,36}$/.test(seller.data.iban)) {
    return fail('Die IBAN ist nicht gültig.');
  }

  const numberFormat = textField(formData.get('numberFormat'));
  if (!isInvoiceNumberFormat(numberFormat)) {
    return fail(
      'Das Format der Rechnungsnummer braucht eine laufende Nummer wie {NNNN}; erlaubt sind außerdem {YYYY}, {YY}, Buchstaben, Ziffern und - _ / .'
    );
  }
  const numberStart = Number(textField(formData.get('numberStart')));
  if (!Number.isInteger(numberStart) || numberStart < 1 || numberStart > 9_999_999) {
    return fail('Die Startnummer muss eine ganze Zahl ab 1 sein.');
  }
  const paymentTermDays = Number(textField(formData.get('paymentTermDays')));
  if (!Number.isInteger(paymentTermDays) || paymentTermDays < 0 || paymentTermDays > 90) {
    return fail('Das Zahlungsziel muss zwischen 0 und 90 Tagen liegen.');
  }

  const admin = createSupabaseAdminClient();
  if (!admin) return fail(NO_SERVICE_ROLE);
  const saved = await saveSellerSettings(
    admin,
    { seller: seller.data, numberFormat, numberStart, paymentTermDays },
    userId
  );
  if (saved.error) return fail('Die Angaben konnten nicht gespeichert werden.');

  revalidatePath(INVOICES);
  revalidatePath(target);
  redirect(backUrl(formData, target, { notice: 'Rechnungssteller gespeichert.' }));
}

// --- invoices -------------------------------------------------------------------

const createSchema = z.object({ orgId: z.uuid(), period: z.string().regex(/^\d{4}-\d{2}$/) });

/** Issues the invoice of a customer for one finished month. */
export async function createInvoice(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const parsed = createSchema.safeParse({
    orgId: textField(formData.get('orgId')),
    period: textField(formData.get('period')),
  });
  if (!parsed.success) {
    redirect(backUrl(formData, INVOICES, { error: 'Bitte Kunde und Monat wählen.' }));
  }
  const fallback = `/admin/billing/${parsed.data.orgId}`;
  const admin = createSupabaseAdminClient();
  if (!admin) redirect(backUrl(formData, fallback, { error: NO_SERVICE_ROLE }));

  const result = await issueInvoiceForMonth(admin, { ...parsed.data, userId });
  revalidateInvoices(parsed.data.orgId);
  redirect(
    backUrl(
      formData,
      fallback,
      result.ok
        ? {
            notice: `Rechnung ${result.invoice.number} erstellt. Das PDF wird erzeugt und an ${result.invoice.mailTo ?? 'die Rechnungs-E-Mail'} gesendet.`,
          }
        : { error: result.error }
    )
  );
}

const idSchema = z.object({ invoiceId: z.uuid() });

function invoiceIdOf(formData: FormData): string {
  const parsed = idSchema.safeParse({ invoiceId: textField(formData.get('invoiceId')) });
  if (!parsed.success) {
    redirect(backUrl(formData, INVOICES, { error: 'Die Rechnung wurde nicht gefunden.' }));
  }
  return parsed.data.invoiceId;
}

export async function markInvoicePaid(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const invoiceId = invoiceIdOf(formData);
  const paid = textField(formData.get('paid')) === 'true';
  const admin = createSupabaseAdminClient();
  if (!admin) redirect(backUrl(formData, INVOICES, { error: NO_SERVICE_ROLE }));
  const result = await setInvoicePaid(admin, {
    invoiceId,
    paid,
    note: textField(formData.get('note')),
    userId,
  });
  revalidateInvoices(textField(formData.get('orgId')) || null);
  redirect(
    backUrl(
      formData,
      INVOICES,
      result.error
        ? { error: result.error }
        : { notice: paid ? 'Als bezahlt markiert.' : 'Wieder als offen markiert.' }
    )
  );
}

export async function resendInvoice(formData: FormData): Promise<void> {
  await requirePlatformAdmin();
  const invoiceId = invoiceIdOf(formData);
  const admin = createSupabaseAdminClient();
  if (!admin) redirect(backUrl(formData, INVOICES, { error: NO_SERVICE_ROLE }));
  const result = await requestInvoiceMail(admin, invoiceId);
  revalidateInvoices(textField(formData.get('orgId')) || null);
  redirect(
    backUrl(
      formData,
      INVOICES,
      result.error ? { error: result.error } : { notice: 'Die Rechnung wird erneut gesendet.' }
    )
  );
}

export async function cancelInvoiceAction(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const invoiceId = invoiceIdOf(formData);
  const admin = createSupabaseAdminClient();
  if (!admin) redirect(backUrl(formData, INVOICES, { error: NO_SERVICE_ROLE }));
  const result = await cancelInvoice(admin, { invoiceId, userId });
  revalidateInvoices(textField(formData.get('orgId')) || null);
  redirect(
    backUrl(
      formData,
      INVOICES,
      result.ok
        ? {
            notice: `Storniert mit Stornorechnung ${result.invoice.number}. Für den Monat kann jetzt eine neue Rechnung erstellt werden.`,
          }
        : { error: result.error }
    )
  );
}

// --- the customer's billing details, entered by the operator ---------------------------

/** Saves a customer's billing details (works without Stripe billing). */
export async function saveCustomerBillingDetails(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const orgId = textField(formData.get('orgId'));
  if (!z.uuid().safeParse(orgId).success) {
    redirect(backUrl(formData, '/admin/billing', { error: 'Organisation wurde nicht gefunden.' }));
  }
  const page = `/admin/billing/${orgId}`;
  const parsed = billingDetailsSchema.safeParse(billingDetailsFromForm(formData));
  if (!parsed.success) {
    redirect(`${page}?panel=details&error=${encodeURIComponent(billingDetailsErrorMessage(parsed.error))}`);
  }
  const admin = createSupabaseAdminClient();
  if (!admin) redirect(`${page}?panel=details&error=${encodeURIComponent(NO_SERVICE_ROLE)}`);
  const saved = await saveBillingDetailsRow(admin, { orgId, details: parsed.data, userId });
  if (saved.error) {
    redirect(
      `${page}?panel=details&error=${encodeURIComponent('Die Rechnungsdaten konnten nicht gespeichert werden.')}`
    );
  }
  revalidatePath(page);
  redirect(`${page}?notice=${encodeURIComponent('Rechnungsdaten gespeichert.')}`);
}

/** The operator vouches for the customer's VAT id (needed for an EU customer outside Germany). */
export async function confirmCustomerVatId(formData: FormData): Promise<void> {
  const { userId } = await requirePlatformAdmin();
  const orgId = textField(formData.get('orgId'));
  if (!z.uuid().safeParse(orgId).success) {
    redirect(backUrl(formData, '/admin/billing', { error: 'Organisation wurde nicht gefunden.' }));
  }
  const page = `/admin/billing/${orgId}`;
  const admin = createSupabaseAdminClient();
  if (!admin) redirect(backUrl(formData, page, { error: NO_SERVICE_ROLE }));
  const result = await confirmAccountVatId(admin, orgId, userId);
  revalidatePath(page);
  redirect(
    backUrl(formData, page, result.error ? { error: result.error } : { notice: 'USt-ID bestätigt.' })
  );
}
