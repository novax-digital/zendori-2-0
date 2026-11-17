'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import type { ConversationMode } from '@zendori/core';
import { acceptDraft, discardDraft, markDraftEdited } from '@/app/inbox/actions';
import Badge, { type BadgeTone } from '@/components/ui/Badge';
import Button, { type ButtonVariant } from '@/components/ui/Button';
import Icon from '@/components/ui/Icon';
import type { AgentInfo, DraftItem } from '@/lib/inbox/types';

// Fallback badge threshold when the channel has no assigned agent (0011: the
// assigned agent's confidence_threshold is authoritative). The color only
// signals how reliable the draft is.
const CONFIDENCE_REFERENCE = 0.7;

type ConfidenceTone = { label: string; tone: BadgeTone };

function confidenceTone(confidence: number, reference: number): ConfidenceTone {
  if (confidence >= reference) return { label: 'Hohe Sicherheit', tone: 'success' };
  if (confidence >= 0.4) return { label: 'Mittlere Sicherheit', tone: 'warn' };
  return { label: 'Niedrige Sicherheit', tone: 'danger' };
}

type SuggestedReplyProps = {
  orgId: string;
  conversationId: string;
  filterStatus: string;
  filterChannel: string;
  filterQ: string;
  mode: ConversationMode;
  draft: DraftItem;
  /** Agent assigned to this conversation's channel (threshold + name). */
  agent?: AgentInfo | null;
  /** Resolved handoff reason (mode='human' only) — replaces the old hardcoded
   *  "von Ihnen übernommen" claim, which was wrong for bot-triggered handoffs. */
  pausedHint?: string | null;
};

function ActionButton({ variant, children }: { variant: ButtonVariant; children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="sm" disabled={pending}>
      {pending ? '…' : children}
    </Button>
  );
}

/** The pending AI draft above the composer: one outlined block (styles: app/styles/inbox.css). */
export default function SuggestedReply({
  orgId,
  conversationId,
  filterStatus,
  filterChannel,
  filterQ,
  mode,
  draft,
  agent,
  pausedHint,
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
      <input type="hidden" name="filterQ" value={filterQ} />
    </>
  );

  return (
    <section className="inbox-draft" aria-label="KI-Antwortvorschlag">
      <div className="inbox-draft-head">
        <span className="inbox-draft-title">
          <Icon name="ai" size={14} />
          Antwortvorschlag
        </span>
        {agent ? <span className="muted small">{agent.name}</span> : null}
        <Badge tone={tone.tone} title={`Sicherheit ${confidencePercent} %`}>
          {tone.label} · {confidencePercent} %
        </Badge>
      </div>
      {mode === 'human' ? (
        <p className="muted small">
          {pausedHint ?? 'Bot pausiert — Konversation liegt beim Team.'} Dieser Vorschlag bleibt
          als Entwurf nutzbar.
        </p>
      ) : null}

      {editing ? (
        <form action={markDraftEdited} className="inbox-draft-form">
          {hiddenFields}
          <textarea
            name="content"
            value={editContent}
            onChange={(event) => setEditContent(event.target.value)}
            rows={5}
            required
            aria-label="Vorschlag bearbeiten"
          />
          <div className="inbox-draft-actions">
            <ActionButton variant="primary">Bearbeitete Antwort senden</ActionButton>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setEditing(false);
                setEditContent(draft.content);
              }}
            >
              Abbrechen
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="inbox-draft-body">{draft.content}</div>
          <div className="inbox-draft-actions">
            <form action={acceptDraft}>
              {hiddenFields}
              <ActionButton variant="primary">Übernehmen</ActionButton>
            </form>
            <Button type="button" size="sm" onClick={() => setEditing(true)}>
              Bearbeiten
            </Button>
            <form action={discardDraft}>
              {hiddenFields}
              <ActionButton variant="ghost">Verwerfen</ActionButton>
            </form>
          </div>
        </>
      )}

      {draft.sources.length > 0 ? (
        <div className="inbox-draft-sources">
          <span className="strong">Quellen</span>
          {draft.sources.map((source, index) => (
            <span key={`${source.source_id}-${index}`}>
              <span className="inbox-draft-source-name">
                {source.uri
                  ? // manual entries store the literal marker 'text' as uri — show
                    // the same label the knowledge settings page uses
                    source.uri === 'text'
                    ? 'Manueller Text'
                    : source.uri
                  : 'Wissensdatenbank-Eintrag'}
              </span>
              {source.snippet ? <span> — {source.snippet}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
