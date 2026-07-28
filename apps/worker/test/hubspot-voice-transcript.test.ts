import { describe, expect, it } from 'vitest';
import {
  buildTicketContent,
  buildVoiceTranscriptBody,
  formatVoiceTurn,
} from '../src/pipeline/hubspot-sync.js';

// Voice → HubSpot (owner request 2026-07-28): the ticket body carries the
// COMPLETE call transcript (caller + assistant), not just the first caller turn.
// The size cap and the note watermark must agree: turns cut from the body stay
// after the watermark and reach HubSpot as notes.

const TURNS = [
  { content: 'Hallo, hier Kai Beispiel von der Beispiel GmbH.', created_at: '2026-07-28T09:00:01Z', sender_type: 'contact' },
  { content: 'Guten Tag! Wie kann ich helfen?', created_at: '2026-07-28T09:00:05Z', sender_type: 'bot' },
  { content: 'Unsere Wallbox lädt nicht mehr.', created_at: '2026-07-28T09:00:12Z', sender_type: 'contact' },
];

describe('formatVoiceTurn', () => {
  it('labels caller and assistant turns', () => {
    expect(formatVoiceTurn(TURNS[0]!)).toBe(
      'Anrufer: Hallo, hier Kai Beispiel von der Beispiel GmbH.'
    );
    expect(formatVoiceTurn(TURNS[1]!)).toBe('Assistent: Guten Tag! Wie kann ich helfen?');
  });
});

describe('buildVoiceTranscriptBody', () => {
  it('joins all turns in order with speaker labels and watermarks the last one', () => {
    const { body, notedThrough } = buildVoiceTranscriptBody(TURNS);
    expect(body).toBe(
      [
        'Anrufer: Hallo, hier Kai Beispiel von der Beispiel GmbH.',
        'Assistent: Guten Tag! Wie kann ich helfen?',
        'Anrufer: Unsere Wallbox lädt nicht mehr.',
      ].join('\n')
    );
    expect(notedThrough).toBe('2026-07-28T09:00:12Z');
  });

  it('falls back to a placeholder for a transcript-less call', () => {
    expect(buildVoiceTranscriptBody([])).toEqual({ body: '(kein Transkript)', notedThrough: null });
  });

  it('caps a long transcript and watermarks only the last INCLUDED turn', () => {
    const turns = Array.from({ length: 2000 }, (_, i) => ({
      content: 'x'.repeat(100),
      created_at: `2026-07-28T09:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
      sender_type: 'contact',
    }));
    const { body, notedThrough } = buildVoiceTranscriptBody(turns);
    expect(body.length).toBeLessThanOrEqual(60_100); // cap + truncation marker
    expect(body).toContain('(Transkript gekürzt — Fortsetzung als Notiz)');
    // the watermark must NOT point at the last loaded turn — the cut turns
    // still have to reach HubSpot as notes
    expect(notedThrough).not.toBe(turns[turns.length - 1]!.created_at);
    expect(notedThrough).toBeTruthy();
  });

  it('includes a sliced first turn when a single turn exceeds the cap', () => {
    const huge = { content: 'y'.repeat(70_000), created_at: '2026-07-28T09:00:01Z', sender_type: 'contact' };
    const { body, notedThrough } = buildVoiceTranscriptBody([huge]);
    expect(body.length).toBeLessThanOrEqual(60_000);
    expect(body.startsWith('Anrufer: yyy')).toBe(true);
    expect(notedThrough).toBe('2026-07-28T09:00:01Z');
  });

  it('composes with the shared ticket footer', () => {
    const content = buildTicketContent({
      body: buildVoiceTranscriptBody(TURNS).body,
      attachments: [],
      channelName: 'Zentrale +49 30 …',
      receivedAt: '2026-07-28T09:00:01Z',
    });
    expect(content).toContain('Anrufer: Hallo, hier Kai Beispiel von der Beispiel GmbH.');
    expect(content).toContain('— Eingang über Kanal "Zentrale +49 30 …" am 2026-07-28T09:00:01Z');
  });
});
