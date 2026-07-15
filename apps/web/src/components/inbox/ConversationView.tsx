import type { SenderType } from '@zendori/core';
import type { ConversationDetail } from '@/lib/inbox/types';

const senderLabels: Record<SenderType, string> = {
  contact: 'Kunde',
  agent: 'Agent',
  bot: 'Bot',
  system: 'System',
};

/** Compact, locale-agnostic byte size for attachment labels. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

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
              {message.attachments.length > 0 ? (
                <div
                  style={{
                    marginTop: '0.35rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.2rem',
                  }}
                >
                  {message.attachments.map((attachment) =>
                    attachment.mime.startsWith('audio/') && attachment.url ? (
                      <span
                        key={attachment.id}
                        style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}
                      >
                        <audio controls preload="none" src={attachment.url} style={{ width: '100%' }}>
                          <a href={attachment.url} target="_blank" rel="noreferrer">
                            {attachment.filename}
                          </a>
                        </audio>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          🎧 {attachment.filename} ({formatBytes(attachment.size)})
                        </span>
                      </span>
                    ) : (
                      <span
                        key={attachment.id}
                        style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}
                      >
                        📎{' '}
                        {attachment.url ? (
                          <a href={attachment.url} target="_blank" rel="noreferrer" download>
                            {attachment.filename}
                          </a>
                        ) : (
                          <span>{attachment.filename}</span>
                        )}{' '}
                        <span style={{ color: 'var(--text-muted)' }}>
                          ({formatBytes(attachment.size)})
                        </span>
                      </span>
                    )
                  )}
                </div>
              ) : null}
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
