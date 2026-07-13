// Ticket create / stage update / idempotent lookup (docs/legacy-analysis.md §2.7).
// Idempotency anchor: the zendori_ref custom property = the conversation UUID.
import { isSuccess, parseJson, request, requestFailed } from './client.js';
import {
  PRIORITY_MAP,
  objectResponseSchema,
  searchResponseSchema,
  type HubSpotConfig,
  type HubSpotPriority,
  type TicketDraft,
  type TicketRef,
} from './schemas.js';

const TICKETS_PATH = '/crm/v3/objects/tickets';
const TICKETS_SEARCH_PATH = '/crm/v3/objects/tickets/search';

/** HUBSPOT_DEFINED association type id ticket→contact (§2.7). */
export const TICKET_TO_CONTACT_TYPE_ID = 16;

function ticketPayload(draft: TicketDraft, contactId: string, priority: HubSpotPriority): unknown {
  return {
    properties: {
      subject: draft.subject,
      content: draft.content,
      hs_pipeline: draft.pipelineId,
      hs_pipeline_stage: draft.stageId,
      hs_ticket_priority: priority,
      zendori_source: draft.sourceChannel,
      zendori_ref: draft.ref,
    },
    associations: [
      {
        to: { id: contactId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: TICKET_TO_CONTACT_TYPE_ID,
          },
        ],
      },
    ],
  };
}

/**
 * Create a ticket associated to a contact. On a 400 that mentions "priority"
 * (some portals lack the URGENT option), degrade once to HIGH and retry (§2.7).
 */
export async function createTicket(
  config: HubSpotConfig,
  draft: TicketDraft,
  contactId: string
): Promise<TicketRef> {
  const priority = PRIORITY_MAP[draft.priority];
  const res = await request(
    config,
    'POST',
    TICKETS_PATH,
    ticketPayload(draft, contactId, priority)
  );
  if (isSuccess(res.status)) {
    return { id: parseJson(objectResponseSchema, res, 'POST', TICKETS_PATH).id };
  }
  if (res.status === 400 && /priority/i.test(res.bodyText) && priority !== 'HIGH') {
    const retry = await request(
      config,
      'POST',
      TICKETS_PATH,
      ticketPayload(draft, contactId, 'HIGH')
    );
    if (isSuccess(retry.status)) {
      return { id: parseJson(objectResponseSchema, retry, 'POST', TICKETS_PATH).id };
    }
    throw requestFailed('POST', TICKETS_PATH, retry);
  }
  throw requestFailed('POST', TICKETS_PATH, res);
}

/** Move an existing ticket to a pipeline stage (resolved → resolved_stage_id). */
export async function updateTicketStage(
  config: HubSpotConfig,
  ticketId: string,
  stageId: string
): Promise<void> {
  const path = `${TICKETS_PATH}/${encodeURIComponent(ticketId)}`;
  const res = await request(config, 'PATCH', path, {
    properties: { hs_pipeline_stage: stageId },
  });
  if (!isSuccess(res.status)) throw requestFailed('PATCH', path, res);
}

/**
 * Look up a ticket by its zendori_ref (idempotency). 200 → exists, 404 → null,
 * 400 → fall back to a search (idProperty lookup can 400 while the unique index
 * is still provisioning). No search-before-create in the hot path (§2.7).
 */
export async function findTicketByRef(
  config: HubSpotConfig,
  ref: string
): Promise<TicketRef | null> {
  const path = `${TICKETS_PATH}/${encodeURIComponent(ref)}?idProperty=zendori_ref`;
  const res = await request(config, 'GET', path);
  if (isSuccess(res.status)) {
    return { id: parseJson(objectResponseSchema, res, 'GET', path).id };
  }
  if (res.status === 404) return null;
  if (res.status === 400) return searchTicketByRef(config, ref);
  throw requestFailed('GET', path, res);
}

async function searchTicketByRef(config: HubSpotConfig, ref: string): Promise<TicketRef | null> {
  const res = await request(config, 'POST', TICKETS_SEARCH_PATH, {
    filterGroups: [{ filters: [{ propertyName: 'zendori_ref', operator: 'EQ', value: ref }] }],
    properties: ['zendori_ref'],
    limit: 1,
  });
  if (!isSuccess(res.status)) throw requestFailed('POST', TICKETS_SEARCH_PATH, res);
  const parsed = parseJson(searchResponseSchema, res, 'POST', TICKETS_SEARCH_PATH);
  const first = parsed.results[0];
  return first ? { id: first.id } : null;
}
