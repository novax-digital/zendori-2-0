import {
  isSuppressedEmailRecipient,
  renderFormNotificationEmail,
  sendEmail,
  type NotificationField,
} from '@zendori/channels';
import type { Logger, SupabaseClient } from '@zendori/core';
import { toErrorInfo } from '../db.js';

// Phase 10: forwards a form submission as a styled HTML mail to the recipients
// configured on the form (form_notifications rows written by the submit
// route). Runs in the worker (§12: Vercel does nothing long-running, retries
// come from pg-boss). ONE Resend send with all recipients in `to`; failures
// end as state='failed' + an internal note incl. the provider error so the
// owner can spot a broken address. Never logs content or addresses (§7).

export const FORM_NOTIFY_QUEUE = 'form.notify';
export const FORM_NOTIFY_RETRY_LIMIT = 5;

export interface FormNotifyJob {
  notificationId: string;
}

interface NotificationRow {
  id: string;
  org_id: string;
  form_id: string;
  message_id: string;
  recipients: unknown;
  state: string;
  attempts: number;
}

interface SnapshotField {
  label?: unknown;
  value?: unknown;
}

/** Extracts the display fields from messages.metadata.form (snapshot). */
function snapshotFields(metadata: Record<string, unknown> | null): NotificationField[] {
  const form = metadata?.form;
  if (!form || typeof form !== 'object' || Array.isArray(form)) return [];
  const fields = (form as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return [];
  const result: NotificationField[] = [];
  for (const entry of fields as SnapshotField[]) {
    if (typeof entry?.label === 'string' && typeof entry?.value === 'string') {
      result.push({ label: entry.label, value: entry.value });
    }
  }
  return result;
}

function snapshotConsentText(metadata: Record<string, unknown> | null): string | null {
  const form = metadata?.form;
  if (!form || typeof form !== 'object' || Array.isArray(form)) return null;
  const consent = (form as { consent?: unknown }).consent;
  if (!consent || typeof consent !== 'object' || Array.isArray(consent)) return null;
  const text = (consent as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
}

/** Submitter e-mail from the contact of the conversation (Reply-To target). */
async function loadSubmitterEmail(
  supabase: SupabaseClient,
  orgId: string,
  conversationId: string
): Promise<string | null> {
  const { data: convRow } = await supabase
    .from('conversations')
    .select('contact_id')
    .eq('org_id', orgId)
    .eq('id', conversationId)
    .maybeSingle();
  const contactId = (convRow as { contact_id: string | null } | null)?.contact_id;
  if (!contactId) return null;
  const { data: contactRow } = await supabase
    .from('contacts')
    .select('email')
    .eq('org_id', orgId)
    .eq('id', contactId)
    .maybeSingle();
  return (contactRow as { email: string | null } | null)?.email ?? null;
}

export async function processFormNotification(
  supabase: SupabaseClient,
  logger: Logger,
  job: FormNotifyJob,
  /** pg-boss retryCount (0 on the first attempt) — same semantics as the other queues. */
  retryCount: number
): Promise<void> {
  const { data: rowData, error: rowError } = await supabase
    .from('form_notifications')
    .select('id, org_id, form_id, message_id, recipients, state, attempts')
    .eq('id', job.notificationId)
    .maybeSingle();
  if (rowError) throw rowError;
  const notification = rowData as NotificationRow | null;
  if (!notification || notification.state !== 'pending') return; // done or gone

  const recipients = (Array.isArray(notification.recipients) ? notification.recipients : [])
    .filter((entry): entry is string => typeof entry === 'string' && entry.includes('@'))
    .filter((entry) => !isSuppressedEmailRecipient(entry))
    .slice(0, 10);
  if (recipients.length === 0) {
    await supabase
      .from('form_notifications')
      .update({ state: 'failed', last_error: 'Keine zustellbaren Empfänger.' })
      .eq('id', notification.id);
    return;
  }

  // Load message snapshot + org/form context.
  const { data: messageData, error: messageError } = await supabase
    .from('messages')
    .select('id, conversation_id, metadata, created_at')
    .eq('org_id', notification.org_id)
    .eq('id', notification.message_id)
    .maybeSingle();
  if (messageError) throw messageError;
  const message = messageData as {
    id: string;
    conversation_id: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
  } | null;
  if (!message) {
    await supabase
      .from('form_notifications')
      .update({ state: 'failed', last_error: 'Nachricht existiert nicht mehr.' })
      .eq('id', notification.id);
    return;
  }

  const [{ data: formRow }, { data: orgRow }] = await Promise.all([
    supabase
      .from('forms')
      .select('name, definition, channel_id')
      .eq('id', notification.form_id)
      .maybeSingle(),
    supabase.from('organizations').select('name').eq('id', notification.org_id).maybeSingle(),
  ]);
  const formName = (formRow as { name: string } | null)?.name ?? 'Formular';
  const orgName = (orgRow as { name: string } | null)?.name ?? 'Zendori';

  const channelId = (formRow as { channel_id: string } | null)?.channel_id ?? null;
  let channelConfig: Record<string, unknown> = {};
  if (channelId) {
    const { data: channelRow } = await supabase
      .from('channels')
      .select('config')
      .eq('org_id', notification.org_id)
      .eq('id', channelId)
      .maybeSingle();
    channelConfig = (channelRow as { config?: Record<string, unknown> } | null)?.config ?? {};
  }

  const definition = (formRow as { definition?: unknown } | null)?.definition as
    | { design?: { color?: unknown } }
    | undefined;
  const color =
    typeof definition?.design?.color === 'string' ? definition.design.color : undefined;

  const appUrl = process.env.APP_URL?.replace(/\/+$/, '');
  const conversationUrl = appUrl
    ? `${appUrl}/inbox?conversation=${message.conversation_id}`
    : null;

  const rendered = renderFormNotificationEmail({
    orgName,
    formName,
    fields: snapshotFields(message.metadata),
    consentText: snapshotConsentText(message.metadata),
    conversationUrl,
    ...(color ? { color } : {}),
    submittedAt: new Date(message.created_at),
  });

  const resendFrom = process.env.RESEND_FROM;
  const senderDomain =
    typeof channelConfig.senderDomain === 'string' ? channelConfig.senderDomain : undefined;
  const from = senderDomain ? `support@${senderDomain}` : resendFrom;
  if (!from) {
    await supabase
      .from('form_notifications')
      .update({ state: 'failed', last_error: 'RESEND_FROM ist nicht konfiguriert.' })
      .eq('id', notification.id);
    return;
  }

  const submitterEmail = await loadSubmitterEmail(
    supabase,
    notification.org_id,
    message.conversation_id
  );
  const replyTo =
    submitterEmail && !isSuppressedEmailRecipient(submitterEmail) ? submitterEmail : undefined;

  // Claim BEFORE the external send (at-most-once, like the auto-send pipeline):
  // the row flips pending→sent atomically; a concurrent/duplicate job sees 0
  // rows and stops. A crash between claim and send loses one notification
  // instead of spamming the recipients on every retry — the safer failure.
  const { data: claimed, error: claimError } = await supabase
    .from('form_notifications')
    .update({
      state: 'sent',
      attempts: notification.attempts + 1,
      sent_at: new Date().toISOString(),
      last_error: null,
    })
    .eq('id', notification.id)
    .eq('state', 'pending')
    .eq('attempts', notification.attempts)
    .select('id');
  if (claimError) throw claimError;
  if (!claimed || claimed.length === 0) return; // lost the claim — someone else ran

  try {
    await sendEmail({
      from,
      to: recipients,
      ...(replyTo ? { replyTo } : {}),
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
  } catch (err) {
    const providerError = (err as Error).message?.slice(0, 300) ?? 'Versand fehlgeschlagen.';
    const isFinalAttempt = retryCount >= FORM_NOTIFY_RETRY_LIMIT;
    // revert the claim: back to pending for the next retry, or terminal failed
    const { error: revertError } = await supabase
      .from('form_notifications')
      .update({
        state: isFinalAttempt ? 'failed' : 'pending',
        sent_at: null,
        last_error: providerError,
      })
      .eq('id', notification.id);
    if (revertError) {
      logger.error(
        { notificationId: notification.id, err: toErrorInfo(revertError) },
        'form notification revert failed'
      );
    }
    if (isFinalAttempt) {
      // internal note incl. provider error so the team can spot the broken
      // address (form_notifications.last_error has no UI yet)
      const { error: noteError } = await supabase.from('notes').insert({
        org_id: notification.org_id,
        conversation_id: message.conversation_id,
        author_id: null,
        content: `⚠️ Formular-Weiterleitung an ${recipients.length} Adresse(n) fehlgeschlagen (${providerError}). Bitte die Empfängerliste des Formulars prüfen.`,
      });
      if (noteError) {
        logger.error(
          { notificationId: notification.id, err: toErrorInfo(noteError) },
          'form notification note failed'
        );
      }
      logger.warn(
        { notificationId: notification.id, err: toErrorInfo(err) },
        'form notification failed permanently'
      );
      return; // terminal — do not rethrow (state is recorded)
    }
    throw err; // pg-boss retries with backoff
  }
}
