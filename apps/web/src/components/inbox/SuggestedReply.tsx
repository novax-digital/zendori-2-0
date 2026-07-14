'use client';

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useFormStatus } from 'react-dom';
import type { ConversationMode } from '@zendori/core';
import { acceptDraft, discardDraft, markDraftEdited } from '@/app/inbox/actions';
import type { AgentInfo, DraftItem } from '@/lib/inbox/types';

// Fallback badge threshold when the channel has no assigned agent (0011: the
// assigned agent's confidence_threshold is authoritative). The color only
// signals how reliable the draft is.
const CONFIDENCE_REFERENCE = 0.7;

type ConfidenceTone = { label: string; background: string; color: string };

function confidenceTone(confidence: number, reference: number): ConfidenceTone {
  if (confidence >= reference) {
    return { label: 'Hohe Sicherheit', background: '#d1fae5', color: '#065f46' };
  }
  if (confidence >= 0.4) {
    return { label: 'Mittlere Sicherheit', background: '#fef3c7', color: '#92400e' };
  }
  return { label: 'Niedrige Sicherheit', background: '#fee2e2', color: '#991b1b' };
}

const cardStyle: CSSProperties = {
  margin: '0 0.75rem 0',
  padding: '0.75rem 0.85rem',
  border: '1px solid var(--border)',
  borderLeft: '3px solid var(--primary)',
  borderRadius: 10,
  background: 'var(--surface)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.6rem',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.6rem',
  flexWrap: 'wrap',
};

const titleStyle: CSSProperties = {
  fontSize: '0.78rem',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
  color: 'var(--text-muted)',
};

const badgeStyle = (tone: ConfidenceTone): CSSProperties => ({
  display: 'inline-block',
  borderRadius: 999,
  padding: '0.1rem 0.6rem',
  fontSize: '0.72rem',
  fontWeight: 600,
  background: tone.background,
  color: tone.color,
});

const bodyStyle: CSSProperties = {
  fontSize: '0.9rem',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: '14rem',
  overflowY: 'auto',
};

const textareaStyle: CSSProperties = {
  width: '100%',
  padding: '0.55rem 0.75rem',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: '0.9rem',
  fontFamily: 'inherit',
  background: 'var(--surface)',
  resize: 'vertical',
};

const sourcesStyle: CSSProperties = {
  fontSize: '0.78rem',
  color: 'var(--text-muted)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.3rem',
  borderTop: '1px solid var(--border)',
  paddingTop: '0.5rem',
};

const actionsStyle: CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  flexWrap: 'wrap',
  alignItems: 'center',
};

const pausedHintStyle: CSSProperties = {
  fontSize: '0.78rem',
  color: 'var(--text-muted)',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '0.4rem 0.6rem',
};

type SuggestedReplyProps = {
  orgId: string;
  conversationId: string;
  filterStatus: string;
  filterChannel: string;
  mode: ConversationMode;
  draft: DraftItem;
  /** Agent assigned to this conversation's channel (threshold + name). */
  agent?: AgentInfo | null;
};

function ActionButton({ className, children }: { className: string; children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending}>
      {pending ? '…' : children}
    </button>
  );
}

export default function SuggestedReply({
  orgId,
  conversationId,
  filterStatus,
  filterChannel,
  mode,
  draft,
  agent,
}: SuggestedReplyProps) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(draft.content);
  const tone = confidenceTone(draft.confidence, agent?.confidence_threshold ?? CONFIDENCE_REFERENCE);
  const confidencePercent = Math.round(Math.max(0, Math.min(1, draft.confidence)) * 100);

  const hiddenFields = (
    <>
      <input type="hidden" name="org" value={orgId} />
      <input type="hidden" name="conversationId" value={conversationId} />
      <input type="hidden" name="draftId" value={draft.id} />
      <input type="hidden" name="filterStatus" value={filterStatus} />
      <input type="hidden" name="filterChannel" value={filterChannel} />
    </>
  );

  return (
    <div style={cardStyle} aria-label="KI-Antwortvorschlag">
      {mode === 'human' ? (
        <div style={pausedHintStyle}>
          Bot pausiert – von Ihnen übernommen. Dieser Vorschlag bleibt als Entwurf nutzbar.
        </div>
      ) : null}
      <div style={headerStyle}>
        <span style={titleStyle}>KI-Vorschlag{agent ? ` — ${agent.name}` : ''}</span>
        <span style={badgeStyle(tone)} title={`Sicherheit ${confidencePercent} %`}>
          {tone.label} · {confidencePercent} %
        </span>
      </div>

      {editing ? (
        <form
          action={markDraftEdited}
          style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
        >
          {hiddenFields}
          <textarea
            name="content"
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
            rows={5}
            required
            style={textareaStyle}
            aria-label="Vorschlag bearbeiten"
          />
          <div style={actionsStyle}>
            <ActionButton className="primary">Bearbeitete Antwort senden</ActionButton>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setEditing(false);
                setEditContent(draft.content);
              }}
            >
              Abbrechen
            </button>
          </div>
        </form>
      ) : (
        <>
          <div style={bodyStyle}>{draft.content}</div>
          <div style={actionsStyle}>
            <form action={acceptDraft}>
              {hiddenFields}
              <ActionButton className="primary">Übernehmen</ActionButton>
            </form>
            <button type="button" className="ghost" onClick={() => setEditing(true)}>
              Bearbeiten
            </button>
            <form action={discardDraft}>
              {hiddenFields}
              <ActionButton className="ghost">Verwerfen</ActionButton>
            </form>
          </div>
        </>
      )}

      {draft.sources.length > 0 ? (
        <div style={sourcesStyle}>
          <span style={{ fontWeight: 600 }}>Quellen</span>
          {draft.sources.map((source, index) => (
            <span key={`${source.source_id}-${index}`} style={{ wordBreak: 'break-word' }}>
              {source.uri ? (
                <span style={{ color: 'var(--text)' }}>{source.uri}</span>
              ) : (
                <span style={{ color: 'var(--text)' }}>Wissensdatenbank-Eintrag</span>
              )}
              {source.snippet ? <span> — {source.snippet}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
