import type { SenderType } from '@zendori/core';
import type { ConversationDetail } from '@/lib/inbox/types';

const senderLabels: Record<SenderType, string> = {
  contact: 'Kunde',
  agent: 'Agent',
  bot: 'Bot',
  system: 'System',
};

/** Fixed German timezone so server-rendered timestamps match what agents expect. */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  });
}

export default function ConversationView({ detail }: { detail: ConversationDetail }) {
  const { conversation, contact, channel, messages } = detail;
  const contactLabel = contact?.name ?? contact?.email ?? 'Unbekannter Kontakt';
  // Rendered newest-first inside a column-reverse container so the latest
  // message is visible at the bottom without any client-side scroll script.
  const newestFirst = [...messages].reverse();

  return (
    <>
      <div className="inbox-view-header">
        <div className="inbox-view-subject">{conversation.subject ?? 'Ohne Betreff'}</div>
        <div className="inbox-view-meta">
          {contactLabel}
          {channel ? ` · ${channel.name}` : ''}
        </div>
      </div>
      <div className="inbox-messages">
        {newestFirst.length === 0 ? (
          <p className="inbox-messages-empty">Noch keine Nachrichten in dieser Konversation.</p>
        ) : (
          newestFirst.map((message) => (
            <div
              key={message.id}
              className={
                message.direction === 'in' ? 'inbox-msg inbox-msg-in' : 'inbox-msg inbox-msg-out'
              }
            >
              <div className="inbox-msg-bubble">{message.content}</div>
              <div className="inbox-msg-meta">
                {senderLabels[message.sender_type]} · {formatTimestamp(message.created_at)}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
