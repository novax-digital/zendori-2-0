import { INLINE_RENDERABLE_MIMES } from '@zendori/core';
import type { SenderType } from '@zendori/core';
import type { MessageWithAttachments } from '@/lib/inbox/types';

// The message bubbles of a conversation (inbox view) — extracted (Phase 11) so
// the ticket detail can render the SAME transcript for its message range.
// Rendered newest-first inside a column-reverse container so the latest
// message is visible at the bottom without any client-side scroll script.

const senderLabels: Record<SenderType, string> = {
  contact: 'Kunde',
  agent: 'Agent',
  bot: 'Bot',
  system: 'System',
};

/**
 * Defensive check for metadata.delivery.failed — written by the reply actions
 * and the worker's deliverBotReply when the outbound send (email/WhatsApp)
 * failed. metadata is untyped jsonb, so every level is guarded.
 */
function isDeliveryFailed(metadata: Record<string, unknown> | null | undefined): boolean {
  const delivery = metadata?.['delivery'];
  return (
    typeof delivery === 'object' &&
    delivery !== null &&
    (delivery as { failed?: unknown }).failed === true
  );
}

/** Provider error string for the hover tooltip (never message content). */
function deliveryErrorText(
  metadata: Record<string, unknown> | null | undefined
): string | undefined {
  const delivery = metadata?.['delivery'];
  if (typeof delivery !== 'object' || delivery === null) return undefined;
  const error = (delivery as { error?: unknown }).error;
  return typeof error === 'string' ? error : undefined;
}

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

export default function MessageThread({
  messages,
  emptyText = 'Noch keine Nachrichten in dieser Konversation.',
}: {
  messages: MessageWithAttachments[];
  emptyText?: string;
}) {
  const newestFirst = [...messages].reverse();
  return (
      <div className="inbox-messages">
        {newestFirst.length === 0 ? (
          <p className="inbox-messages-empty">{emptyText}</p>
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
                    ) : INLINE_RENDERABLE_MIMES.has(attachment.mime) && attachment.url ? (
                      // Raster images render as a thumbnail (0025). The URL is only
                      // signed without a download disposition for this exact
                      // allowlist of types, so nothing here can execute.
                      <span
                        key={attachment.id}
                        style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}
                      >
                        <a href={attachment.url} target="_blank" rel="noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={attachment.url}
                            alt={attachment.filename}
                            loading="lazy"
                            style={{
                              maxWidth: '100%',
                              maxHeight: '240px',
                              borderRadius: '6px',
                              display: 'block',
                            }}
                          />
                        </a>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          🖼 {attachment.filename} ({formatBytes(attachment.size)})
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
                {message.direction === 'out' && isDeliveryFailed(message.metadata) ? (
                  <span
                    style={{ color: 'var(--danger)', fontWeight: 600 }}
                    title={deliveryErrorText(message.metadata)}
                  >
                    {' '}
                    · Zustellung fehlgeschlagen
                  </span>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
  );
}
