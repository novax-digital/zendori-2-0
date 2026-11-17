// Shared bits of the Wissen area (list, knowledge-base detail, source detail):
// labels, the status badge and small formatters. Server-safe — no hooks.
import type { KbSourceStatus, KbSourceType } from '@zendori/core';
import Badge, { type BadgeTone } from '@/components/ui/Badge';

export const SOURCE_TYPE_LABELS: Record<KbSourceType, string> = {
  url: 'URL',
  file: 'Datei',
  text: 'Text',
};

const STATUS_LABELS: Record<KbSourceStatus, string> = {
  pending: 'Ausstehend',
  indexed: 'Indiziert',
  error: 'Fehler',
};

const STATUS_TONES: Record<KbSourceStatus, BadgeTone> = {
  pending: 'warn',
  indexed: 'success',
  error: 'danger',
};

export function SourceStatusBadge({ status }: { status: KbSourceStatus }) {
  return (
    <Badge tone={STATUS_TONES[status]} dot>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

/** Human label for a source (URL / uploaded filename / generic text). */
export function sourceLabel(source: { type: KbSourceType; uri: string | null }): string {
  if (source.type === 'text') return 'Manueller Text';
  return source.uri ?? '—';
}

/** Server-rendered coarse relative time (German), good enough for an index list. */
export function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMin = Math.round((Date.now() - then) / 60_000);
  if (diffMin < 1) return 'gerade eben';
  if (diffMin < 60) return `vor ${diffMin} Min.`;
  const diffHours = Math.round(diffMin / 60);
  if (diffHours < 24) return `vor ${diffHours} Std.`;
  const diffDays = Math.round(diffHours / 24);
  return `vor ${diffDays} ${diffDays === 1 ? 'Tag' : 'Tagen'}`;
}

/** `kbId` comes from the URL — only a UUID may reach a query or a redirect target. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The kinds of source the "Quelle hinzufügen" drawer offers (?type=…). */
export const SOURCE_KINDS = ['url', 'file', 'text', 'qa'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
