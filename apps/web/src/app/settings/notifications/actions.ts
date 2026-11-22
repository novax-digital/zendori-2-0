'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  NOTIFICATION_EVENT_DEFS,
  canSubscribeNotification,
  createLogger,
  isMissingRelationError,
  isNotificationEventType,
  parseNotificationEvents,
} from '@zendori/core';
import {
  isSuppressedEmailRecipient,
  renderMemberNotificationEmail,
  sampleMemberNotification,
  sendEmail,
} from '@zendori/channels';
import { getMemberAccess } from '@/lib/access';
import { checkRateLimit } from '@/lib/rate-limit';
import { createSupabaseServerClient } from '@/lib/supabase/server';

// Personal e-mail notifications (migration 0038). Both actions act for the
// signed-in member only: the row is keyed by (org, auth user) and RLS allows a
// member nothing but their own row.

const log = createLogger('notifications');

const NOT_AVAILABLE = 'Benachrichtigungen sind noch nicht verfügbar (Migration 0038 ausstehend).';

function textField(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function pageUrl(org: string, message?: { error?: string; notice?: string }): string {
  const params = new URLSearchParams({ org });
  if (message?.error) params.set('error', message.error);
  if (message?.notice) params.set('notice', message.notice);
  return `/settings/notifications?${params.toString()}`;
}

/** Saves which events the signed-in member wants an e-mail for. */
export async function saveNotificationPreferences(formData: FormData): Promise<void> {
  const org = textField(formData.get('org'));
  if (!z.uuid().safeParse(org).success) redirect('/settings/notifications');

  const access = await getMemberAccess(org);
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!access || !user) redirect(pageUrl(org, { error: 'Kein Zugriff auf diese Organisation.' }));

  // only known events, and only those the member may see anything of
  const events = parseNotificationEvents(formData.getAll('events')).filter((event) =>
    canSubscribeNotification(access, event)
  );

  const { error } = await supabase.from('notification_preferences').upsert(
    {
      org_id: org,
      user_id: user.id,
      events,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'org_id,user_id' }
  );
  if (error) {
    redirect(
      pageUrl(org, {
        error: isMissingRelationError(error)
          ? NOT_AVAILABLE
          : 'Die Einstellungen konnten nicht gespeichert werden.',
      })
    );
  }
  revalidatePath('/settings/notifications');
  redirect(
    pageUrl(org, {
      notice:
        events.length === 0
          ? 'Gespeichert — du bekommst keine E-Mail-Benachrichtigungen.'
          : 'Benachrichtigungen gespeichert.',
    })
  );
}

/**
 * Sends the template of one event with sample content to the member's own address.
 * The event is bound per button (`sendTestNotification.bind(null, key)`): React
 * overrides the `name` of a button whose formAction is a server action, so a
 * name/value pair on the button never reaches the server.
 */
export async function sendTestNotification(
  eventArg: unknown,
  formData: FormData
): Promise<void> {
  const org = textField(formData.get('org'));
  if (!z.uuid().safeParse(org).success) redirect('/settings/notifications');

  // bound arguments come from the client — validate like any other input
  const event = typeof eventArg === 'string' ? eventArg : '';
  if (!isNotificationEventType(event)) {
    redirect(pageUrl(org, { error: 'Unbekannte Benachrichtigung.' }));
  }

  const access = await getMemberAccess(org);
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!access || !user) redirect(pageUrl(org, { error: 'Kein Zugriff auf diese Organisation.' }));

  const email = user.email ?? '';
  if (!email.includes('@') || isSuppressedEmailRecipient(email)) {
    redirect(pageUrl(org, { error: 'Für dein Konto ist keine E-Mail-Adresse hinterlegt.' }));
  }
  if (!(await checkRateLimit('notify-test-user', user.id))) {
    redirect(pageUrl(org, { error: 'Zu viele Testmails — bitte in ein paar Minuten erneut.' }));
  }

  const from = process.env.RESEND_FROM;
  if (!from) {
    redirect(
      pageUrl(org, { error: 'Der E-Mail-Versand ist nicht eingerichtet (Absender fehlt).' })
    );
  }

  const { data: orgRow } = await supabase
    .from('organizations')
    .select('name')
    .eq('id', org)
    .maybeSingle();
  const orgName = (orgRow as { name?: string } | null)?.name ?? 'Zendori';
  const appUrl = (process.env.APP_URL ?? 'https://app.zendori.ai').replace(/\/+$/, '');

  const rendered = renderMemberNotificationEmail(
    sampleMemberNotification(event, { orgName, appUrl, orgId: org })
  );

  let sent = false;
  try {
    await sendEmail({
      from,
      to: email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    sent = true;
  } catch (err) {
    // content-free: never the address or the mail
    log.error({ err: err instanceof Error ? err.message : 'unknown', event }, 'test mail failed');
  }
  if (!sent) {
    redirect(pageUrl(org, { error: 'Die Testmail konnte nicht gesendet werden.' }));
  }

  const label = NOTIFICATION_EVENT_DEFS.find((d) => d.key === event)?.label ?? event;
  redirect(pageUrl(org, { notice: `Testmail „${label}“ an ${email} gesendet.` }));
}
