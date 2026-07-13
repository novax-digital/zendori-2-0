import { describe, expect, it } from 'vitest';
import { NOTE_BODY_MAX_CHARS, NOTE_TO_TICKET_TYPE_ID, attachNote } from '../src/index.js';
import { createMockFetch, mockConfig } from './helpers.js';

describe('attachNote', () => {
  it('sends hs_timestamp + a source-suffixed body and the note→ticket association', async () => {
    const { fetchImpl, requests } = createMockFetch([{ status: 201, body: { id: 'note-1' } }]);
    await attachNote(mockConfig(fetchImpl), 'tick-1', {
      body: 'Kunde meldet sich erneut.',
      sourceChannel: 'email',
      occurredAt: '2026-07-13T10:00:00.000Z',
    });
    const body = requests[0]?.body as {
      properties: { hs_timestamp: string; hs_note_body: string };
      associations: {
        to: { id: string };
        types: { associationCategory: string; associationTypeId: number }[];
      }[];
    };
    expect(body.properties.hs_timestamp).toBe('2026-07-13T10:00:00.000Z');
    expect(body.properties.hs_note_body).toBe('Kunde meldet sich erneut.\n\n— Quelle: Kanal email');
    expect(body.associations[0]?.to.id).toBe('tick-1');
    expect(body.associations[0]?.types[0]).toEqual({
      associationCategory: 'HUBSPOT_DEFINED',
      associationTypeId: NOTE_TO_TICKET_TYPE_ID,
    });
  });

  it('truncates the body to the HubSpot note limit', async () => {
    const { fetchImpl, requests } = createMockFetch([{ status: 201, body: { id: 'note-1' } }]);
    await attachNote(mockConfig(fetchImpl), 'tick-1', {
      body: 'x'.repeat(NOTE_BODY_MAX_CHARS + 500),
      sourceChannel: 'chat',
      occurredAt: '2026-07-13T10:00:00.000Z',
    });
    const body = requests[0]?.body as { properties: { hs_note_body: string } };
    expect(body.properties.hs_note_body).toHaveLength(NOTE_BODY_MAX_CHARS);
  });
});
