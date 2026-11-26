// The e-mail that asks a customer to set up billing (migration 0044): when the
// operator switches an organization to Stripe billing — or asks again — the
// owners and admins get one mail with a link to Einstellungen → Abrechnung.
//
// Runs in the billing sync job, right after the sync attempt: the mail only
// goes out once Stripe is in order for this customer, and never for a customer
// that is not (or no longer) enabled. A request is TAKEN before anything is
// sent, so a job that dies half-way can lose a mail but never send it twice;
// the outcome is written to the row and shown to the operator, who can ask
// again. Never logs addresses (§7).
import {
  isMissingColumnError,
  isPeriodKey,
  parseBillingAccountRow,
  type BillingAccountRow,
  type Logger,
  type SupabaseClient,
} from '@zendori/core';
import {
  isSuppressedEmailRecipient,
  renderBillingSetupEmail,
  sendEmail,
  type SendEmailParams,
} from '@zendori/channels';
import { toErrorInfo } from '../db.js';
import type { StripeRuntime } from './stripe.js';

const DEFAULT_APP_URL = 'https://app.zendori.ai';

const MONTH_NAMES_DE = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

/** "2026-12" → "Dezember 2026". */
export function periodLabel(periodKey: string | null): string | null {
  if (!isPeriodKey(periodKey)) return null;
  const [year, month] = periodKey.split('-') as [string, string];
  const name = MONTH_NAMES_DE[Number(month) - 1];
  return name ? `${name} ${year}` : null;
}

export interface SetupMailDeps {
  supabase: SupabaseClient;
  logger: Logger;
  stripe: StripeRuntime;
  /** Sender address (RESEND_FROM). */
  from: string | undefined;
  /** Public app URL for the link (APP_URL). */
  appUrl: string | undefined;
  /** Login e-mail of a member; null when the account is gone. Injectable for tests. */
  getUserEmail?: (userId: string) => Promise<string | null>;
  /** Injectable for tests. */
  send?: (params: SendEmailParams) => Promise<unknown>;
  now?: () => number;
}

export type SetupMailOutcome =
  /** Nothing requested, or the sync is still running — a later run decides. */
  | { kind: 'idle' }
  | { kind: 'sent'; recipients: number }
  /** Deliberately nothing sent; `reason` is stored for the operator unless it is `complete`. */
  | { kind: 'not_sent'; reason: SetupMailReason };

export type SetupMailReason =
  /** Billing details and payment method are on file: nothing to ask for. */
  | 'complete'
  /** Stripe billing is not (or no longer) switched on for this customer. */
  | 'disabled'
  /** The Stripe sync failed for good — the billing page would not work for the customer. */
  | 'sync_failed'
  /** No owner or admin with an address we may write to. */
  | 'no_recipient'
  /** RESEND_FROM is not set. */
  | 'not_configured'
  | 'send_failed';

interface SetupRow {
  enabled: boolean;
  invoice_from: string | null;
  payment_method_id: string | null;
  sync_requested_at: string | null;
  sync_error: string | null;
  setup_mail_requested_at: string | null;
}

const SETUP_COLUMNS =
  'enabled, invoice_from, payment_method_id, sync_requested_at, sync_error, setup_mail_requested_at';
const ACCOUNT_COLUMNS =
  'legal_name, address_line1, address_line2, postal_code, city, country, vat_id, billing_email';

async function defaultGetUserEmail(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error) {
    if (error.status === 404) return null;
    throw error;
  }
  return data.user?.email ?? null;
}

/** Login addresses of the owners and admins of an organization (deduplicated). */
async function loadRecipients(deps: SetupMailDeps, orgId: string): Promise<string[]> {
  const { data, error } = await deps.supabase
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .in('role', ['owner', 'admin']);
  if (error) throw error;
  const getEmail = deps.getUserEmail ?? ((id: string) => defaultGetUserEmail(deps.supabase, id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of (data ?? []) as { user_id: string }[]) {
    const email = (await getEmail(row.user_id))?.trim();
    if (!email || isSuppressedEmailRecipient(email)) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * Works off a requested setup mail of one organization in the worker's Stripe
 * mode. Safe to call after every sync attempt: without a request it does
 * nothing, and while the sync is still pending it waits for the next run.
 */
export async function sendBillingSetupMail(
  deps: SetupMailDeps,
  orgId: string
): Promise<SetupMailOutcome> {
  const { supabase, stripe, logger } = deps;
  const livemode = stripe.livemode;

  const { data, error } = await supabase
    .from('billing_stripe_customers')
    .select(SETUP_COLUMNS)
    .eq('org_id', orgId)
    .eq('livemode', livemode)
    .maybeSingle();
  if (error) {
    // migration 0044 not applied yet: there is nothing to send
    if (isMissingColumnError(error)) return { kind: 'idle' };
    throw error;
  }
  const row = data as SetupRow | null;
  const requestedAt = row?.setup_mail_requested_at ?? null;
  if (!row || requestedAt === null) return { kind: 'idle' };
  // the sync runs first; a retry of it is another job run that ends up here again
  if (row.enabled && row.sync_requested_at !== null) return { kind: 'idle' };

  // Take the request. Whoever gets the row sends; a second run finds nothing.
  const { data: taken, error: takeError } = await supabase
    .from('billing_stripe_customers')
    .update({ setup_mail_requested_at: null })
    .eq('org_id', orgId)
    .eq('livemode', livemode)
    .eq('setup_mail_requested_at', requestedAt)
    .select('org_id');
  if (takeError) throw takeError;
  if (!taken || taken.length === 0) return { kind: 'idle' };

  const finish = async (outcome: SetupMailOutcome): Promise<SetupMailOutcome> => {
    const patch: Record<string, unknown> =
      outcome.kind === 'sent'
        ? {
            setup_mail_sent_at: new Date((deps.now ?? Date.now)()).toISOString(),
            setup_mail_error: null,
          }
        : {
            // "complete" is not a problem the operator has to look at
            setup_mail_error:
              outcome.kind === 'not_sent' && outcome.reason !== 'complete' ? outcome.reason : null,
          };
    const { error: writeError } = await supabase
      .from('billing_stripe_customers')
      .update(patch)
      .eq('org_id', orgId)
      .eq('livemode', livemode);
    if (writeError) throw writeError;
    logger.info(
      {
        orgId,
        livemode,
        outcome: outcome.kind,
        ...(outcome.kind === 'not_sent' ? { reason: outcome.reason } : {}),
        ...(outcome.kind === 'sent' ? { recipients: outcome.recipients } : {}),
      },
      'billing setup mail'
    );
    return outcome;
  };

  if (!row.enabled) return finish({ kind: 'not_sent', reason: 'disabled' });
  if (row.sync_error !== null) return finish({ kind: 'not_sent', reason: 'sync_failed' });

  const [{ data: accountData, error: accountError }, { data: orgData, error: orgError }] =
    await Promise.all([
      supabase.from('billing_accounts').select(ACCOUNT_COLUMNS).eq('org_id', orgId).maybeSingle(),
      supabase.from('organizations').select('name').eq('id', orgId).maybeSingle(),
    ]);
  if (accountError) throw accountError;
  if (orgError) throw orgError;
  const hasDetails = parseBillingAccountRow((accountData as BillingAccountRow | null) ?? null) !== null;
  const hasPaymentMethod = row.payment_method_id !== null;
  if (hasDetails && hasPaymentMethod) return finish({ kind: 'not_sent', reason: 'complete' });

  if (!deps.from) return finish({ kind: 'not_sent', reason: 'not_configured' });
  const recipients = await loadRecipients(deps, orgId);
  if (recipients.length === 0) return finish({ kind: 'not_sent', reason: 'no_recipient' });

  const appUrl = (deps.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, '');
  const rendered = renderBillingSetupEmail({
    orgName: (orgData as { name: string } | null)?.name ?? 'Ihre Organisation',
    hasDetails,
    hasPaymentMethod,
    firstMonthLabel: periodLabel(row.invoice_from),
    openUrl: `${appUrl}/settings/billing?org=${encodeURIComponent(orgId)}`,
    appUrl,
    livemode,
  });

  // one mail per person, so nobody sees the other addresses
  let delivered = 0;
  for (const to of recipients) {
    try {
      await (deps.send ?? sendEmail)({
        from: deps.from,
        to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      delivered += 1;
    } catch (err) {
      logger.warn({ orgId, livemode, err: toErrorInfo(err) }, 'billing setup mail send failed');
    }
  }
  return finish(
    delivered > 0
      ? { kind: 'sent', recipients: delivered }
      : { kind: 'not_sent', reason: 'send_failed' }
  );
}
