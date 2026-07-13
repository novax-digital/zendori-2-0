// Notes attached to a ticket (docs/legacy-analysis.md §2.7). A note carries the
// follow-up message body plus a "— Quelle: Kanal <ch>" source suffix, capped at
// the HubSpot 65536-char note limit. hs_timestamp is required (ISO).
import { isSuccess, request, requestFailed } from './client.js';
import type { HubSpotConfig, NoteInput } from './schemas.js';

const NOTES_PATH = '/crm/v3/objects/notes';

/** HUBSPOT_DEFINED association type id note→ticket (§2.7). */
export const NOTE_TO_TICKET_TYPE_ID = 228;

/** HubSpot hs_note_body maximum length (§2.7). */
export const NOTE_BODY_MAX_CHARS = 65536;

function buildNoteBody(note: NoteInput): string {
  const full = `${note.body}\n\n— Quelle: Kanal ${note.sourceChannel}`;
  return full.length > NOTE_BODY_MAX_CHARS ? full.slice(0, NOTE_BODY_MAX_CHARS) : full;
}

/** Attach a note to a ticket (inline note→ticket association). */
export async function attachNote(
  config: HubSpotConfig,
  ticketId: string,
  note: NoteInput
): Promise<void> {
  const payload = {
    properties: {
      hs_timestamp: note.occurredAt,
      hs_note_body: buildNoteBody(note),
    },
    associations: [
      {
        to: { id: ticketId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: NOTE_TO_TICKET_TYPE_ID,
          },
        ],
      },
    ],
  };
  const res = await request(config, 'POST', NOTES_PATH, payload);
  if (!isSuccess(res.status)) throw requestFailed('POST', NOTES_PATH, res);
}
