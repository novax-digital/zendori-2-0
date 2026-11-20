import {
  NOTIFICATION_EVENT_DEFS,
  type NotificationEntityType,
  type NotificationEventType,
} from '@zendori/core';
import { escapeHtml } from '../form/notification-email.js';
import { renderZendoriEmail, type ZendoriMailDetail } from '../email/brand-mail.js';

// E-mail templates for member notifications (migration 0038): one template per
// event, all on the branded Zendori layout. The worker renders them with real
// records, the settings page with sample data ("Testmail senden").
//
// Data minimisation: a notification names the record (subject, contact name,
// channel, ticket id) and links to it — it never carries message texts.

export interface MemberNotificationInput {
  event: NotificationEventType;
  orgName: string;
  entityType: NotificationEntityType;
  /** Subject of the conversation / ticket; may be empty. */
  subject: string | null;
  ticketDisplayId?: string | null;
  channelName?: string | null;
  contactName?: string | null;
  /** handoff.pending only: handoff_events.reason */
  handoffReason?: string | null;
  occurredAt: Date;
  /** Deep link to the record; null when the app URL is unknown. */
  openUrl: string | null;
  /** Link to the member's notification settings. */
  settingsUrl: string | null;
  appUrl: string;
  /** Test mail with sample content. */
  test?: boolean;
}

const HANDOFF_REASON_LABELS: Record<string, string> = {
  low_confidence: 'Der KI-Agent war sich bei der Antwort nicht sicher',
  user_request: 'Der Kunde möchte mit einem Menschen sprechen',
  keyword: 'Ein Eskalations-Stichwort ist gefallen',
  intake: 'Reine Annahme — das Anliegen wurde aufgenommen',
};

const SUBJECT_MAX = 140;

/** One line, no control characters, bounded length (subjects come from customers). */
function oneLine(value: string, max = SUBJECT_MAX): string {
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function eventLabel(event: NotificationEventType): string {
  return NOTIFICATION_EVENT_DEFS.find((d) => d.key === event)?.label ?? event;
}

function dateText(date: Date): string {
  return date.toLocaleString('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Berlin',
  });
}

interface Wording {
  subject: string;
  preheader: string;
  /** developer-authored HTML */
  paragraph: string;
}

function wording(input: MemberNotificationInput): Wording {
  const org = escapeHtml(input.orgName);
  const subject = input.subject ? oneLine(input.subject) : '';
  const contact = input.contactName ? oneLine(input.contactName, 80) : '';
  const ticketId = input.ticketDisplayId ? oneLine(input.ticketDisplayId, 40) : '';
  const ticketName = ticketId ? `Ticket ${ticketId}` : 'Ticket';

  switch (input.event) {
    case 'conversation.new':
      return {
        subject: subject
          ? `Neue Konversation: ${subject}`
          : contact
            ? `Neue Konversation von ${contact}`
            : 'Neue Konversation',
        preheader: `In ${input.orgName} ist eine neue Konversation eingegangen.`,
        paragraph: `in <strong>${org}</strong> ist eine neue Konversation eingegangen.`,
      };
    case 'ticket.new':
      return {
        subject: subject ? `Neues ${ticketName}: ${subject}` : `Neues ${ticketName}`,
        preheader: `In ${input.orgName} wurde ein neues Ticket angelegt.`,
        paragraph: `in <strong>${org}</strong> wurde ein neues Ticket angelegt.`,
      };
    case 'handoff.pending':
      return {
        subject: subject
          ? `Wartet auf einen Mitarbeiter: ${subject}`
          : 'Eine Konversation wartet auf einen Mitarbeiter',
        preheader: 'Der KI-Agent hat eine Konversation an das Team übergeben.',
        paragraph: `der KI-Agent hat in <strong>${org}</strong> eine Konversation an das Team übergeben. Sie wartet auf eine Antwort.`,
      };
    case 'assigned': {
      const what = input.entityType === 'ticket' ? ticketName : 'Konversation';
      return {
        subject: subject ? `Ihnen zugewiesen: ${what} — ${subject}` : `Ihnen zugewiesen: ${what}`,
        preheader: `Ihnen wurde in ${input.orgName} ${input.entityType === 'ticket' ? 'ein Ticket' : 'eine Konversation'} zugewiesen.`,
        paragraph: `Ihnen wurde in <strong>${org}</strong> ${input.entityType === 'ticket' ? 'ein Ticket' : 'eine Konversation'} zugewiesen.`,
      };
    }
  }
}

export function renderMemberNotificationEmail(input: MemberNotificationInput): {
  subject: string;
  html: string;
  text: string;
} {
  const words = wording(input);

  const details: ZendoriMailDetail[] = [];
  if (input.entityType === 'ticket' && input.ticketDisplayId) {
    details.push({ label: 'Ticket', value: oneLine(input.ticketDisplayId, 40) });
  }
  if (input.subject) details.push({ label: 'Betreff', value: oneLine(input.subject, 200) });
  if (input.contactName) details.push({ label: 'Kontakt', value: oneLine(input.contactName, 80) });
  if (input.channelName) details.push({ label: 'Kanal', value: oneLine(input.channelName, 80) });
  if (input.event === 'handoff.pending' && input.handoffReason) {
    const reason = HANDOFF_REASON_LABELS[input.handoffReason];
    if (reason) details.push({ label: 'Grund', value: reason });
  }
  details.push({ label: 'Zeitpunkt', value: dateText(input.occurredAt) });

  const label = escapeHtml(eventLabel(input.event));
  const manage = input.settingsUrl
    ? ` <a href="${escapeHtml(input.settingsUrl)}" style="color:#64748b;text-decoration:underline">Benachrichtigungen verwalten</a>`
    : '';
  const footerNote = `Sie erhalten diese E-Mail, weil Sie „${label}“ in Zendori unter Einstellungen → Benachrichtigungen eingeschaltet haben.${manage}`;

  const { html, text } = renderZendoriEmail({
    preheader: words.preheader,
    paragraphs: [words.paragraph],
    details,
    ...(input.openUrl
      ? {
          cta: {
            label: input.entityType === 'ticket' ? 'Ticket in Zendori öffnen' : 'In Zendori öffnen',
            url: input.openUrl,
          },
        }
      : {}),
    ...(input.test
      ? { notice: 'Testmail mit Beispielinhalt — in Ihrer Organisation ist nichts passiert.' }
      : {}),
    footerNote,
    appUrl: input.appUrl,
  });

  return { subject: input.test ? `[Test] ${words.subject}` : words.subject, html, text };
}

/** Sample content for the test mail of one event. */
export function sampleMemberNotification(
  event: NotificationEventType,
  context: { orgName: string; appUrl: string; orgId: string; now?: Date }
): MemberNotificationInput {
  const appUrl = context.appUrl.replace(/\/+$/, '');
  const org = encodeURIComponent(context.orgId);
  const asTicket = event === 'ticket.new' || event === 'assigned';
  return {
    event,
    orgName: context.orgName,
    entityType: asTicket ? 'ticket' : 'conversation',
    subject: asTicket ? 'Rückfrage zur Lieferung' : 'Frage zu meiner Bestellung',
    ticketDisplayId: asTicket ? 'T-1042' : null,
    channelName: asTicket ? 'E-Mail Support' : 'Website-Chat',
    contactName: 'Erika Mustermann',
    handoffReason: event === 'handoff.pending' ? 'user_request' : null,
    occurredAt: context.now ?? new Date(),
    openUrl: asTicket ? `${appUrl}/tickets?org=${org}` : `${appUrl}/inbox?org=${org}`,
    settingsUrl: `${appUrl}/settings/notifications?org=${org}`,
    appUrl,
    test: true,
  };
}
