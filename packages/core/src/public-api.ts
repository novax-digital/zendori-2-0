import { z } from 'zod';
import { apiKeyFromAuthorization, hashApiKey } from './api-keys.js';
import type { SupabaseClient } from './db.js';
import { requestTicketHubspotSync } from './hubspot-rules.js';
import { conversationPrioritySchema } from './schemas.js';
import { ticketStatusSchema } from './tickets.js';

// Phase 13d — the Zendori API for an org's own end system (/api/v1/*): the way
// BACK of the 2-way sync. An end system authenticates with an API key that
// belongs to exactly one API connection and may then
//   · read a ticket, a conversation (without message bodies) or a contact,
//   · change a ticket's status / priority / category,
//   · correct a contact's master data,
//   · add an internal note to a ticket or conversation,
//   · link its own id to a Zendori record ("ext:<id>" then addresses it).
// It can NOT create conversations or messages (CLAUDE.md §2: no third intake
// path) and never sees another org's data: every query is scoped to the key's
// org_id, which comes from the key row — never from the request.
//
// The functions take the service-role client that the route created for THIS
// request, tagged with the connection as origin, so the outbox triggers (0036)
// do not echo the change back to the caller. They return a plain
// { status, body } — the Next.js route only turns that into a Response.

export interface PublicApiContext {
  orgId: string;
  connectionId: string;
  connectionName: string;
  keyId: string;
}

export interface PublicApiResult {
  status: number;
  body: unknown;
}

export type PublicApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'conflict'
  | 'rate_limited'
  | 'internal';

export function apiError(
  status: number,
  code: PublicApiErrorCode,
  message: string
): PublicApiResult {
  return { status, body: { error: { code, message } } };
}

function apiData(data: unknown, status = 200): PublicApiResult {
  return { status, body: { data } };
}

const NOT_FOUND = (what: string): PublicApiResult =>
  apiError(404, 'not_found', `${what} not found`);
const INTERNAL = (): PublicApiResult => apiError(500, 'internal', 'internal error');

// --- authentication -----------------------------------------------------------------

export type ApiAuthResult =
  { ok: true; context: PublicApiContext } | { ok: false; result: PublicApiResult };

/**
 * Resolve the API key of a request to its org and connection. `admin` is a
 * plain service-role client (api_keys is not readable otherwise). A revoked
 * key, an unknown key and a malformed header are indistinguishable (401).
 */
export async function authenticateApiKey(
  admin: SupabaseClient,
  authorizationHeader: string | null
): Promise<ApiAuthResult> {
  const unauthorized: ApiAuthResult = {
    ok: false,
    result: apiError(401, 'unauthorized', 'missing or invalid API key'),
  };
  const key = apiKeyFromAuthorization(authorizationHeader);
  if (!key) return unauthorized;

  const { data: keyRow, error: keyError } = await admin
    .from('api_keys')
    .select('id, org_id, connection_id, revoked_at')
    .eq('key_hash', hashApiKey(key))
    .maybeSingle();
  if (keyError) return { ok: false, result: INTERNAL() };
  const row = keyRow as {
    id: string;
    org_id: string;
    connection_id: string;
    revoked_at: string | null;
  } | null;
  if (!row || row.revoked_at !== null) return unauthorized;

  const { data: connRow, error: connError } = await admin
    .from('api_connections')
    .select('name, is_active')
    .eq('org_id', row.org_id)
    .eq('id', row.connection_id)
    .maybeSingle();
  if (connError) return { ok: false, result: INTERNAL() };
  const connection = connRow as { name: string; is_active: boolean } | null;
  if (!connection) return unauthorized;
  if (!connection.is_active) {
    return { ok: false, result: apiError(403, 'forbidden', 'this API connection is paused') };
  }

  return {
    ok: true,
    context: {
      orgId: row.org_id,
      connectionId: row.connection_id,
      connectionName: connection.name,
      keyId: row.id,
    },
  };
}

/** `GET /api/v1/me` — lets an integrator verify the key. */
export function apiWhoAmI(ctx: PublicApiContext): PublicApiResult {
  return apiData({
    org_id: ctx.orgId,
    connection: { id: ctx.connectionId, name: ctx.connectionName },
  });
}

// --- record references --------------------------------------------------------------

export type LinkEntityType = 'ticket' | 'conversation' | 'contact';

const uuidSchema = z.uuid();
const EXTERNAL_PREFIX = 'ext:';

/**
 * A path reference is either the Zendori id (uuid) or "ext:<external id>" — the
 * end system's own id it linked earlier (per connection). Returns the Zendori
 * id, or null when the reference is unknown or malformed.
 */
export async function resolveRecordRef(
  db: SupabaseClient,
  ctx: PublicApiContext,
  entityType: LinkEntityType,
  rawRef: string
): Promise<string | null> {
  const ref = rawRef.trim();
  if (ref.startsWith(EXTERNAL_PREFIX)) {
    const externalId = ref.slice(EXTERNAL_PREFIX.length);
    if (externalId.length === 0 || externalId.length > 200) return null;
    const { data, error } = await db
      .from('external_links')
      .select('entity_id')
      .eq('org_id', ctx.orgId)
      .eq('connection_id', ctx.connectionId)
      .eq('entity_type', entityType)
      .eq('external_id', externalId)
      .maybeSingle();
    if (error) throw error;
    return (data as { entity_id: string } | null)?.entity_id ?? null;
  }
  return uuidSchema.safeParse(ref).success ? ref : null;
}

async function externalIdOf(
  db: SupabaseClient,
  ctx: PublicApiContext,
  entityType: LinkEntityType,
  entityId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('external_links')
    .select('external_id')
    .eq('org_id', ctx.orgId)
    .eq('connection_id', ctx.connectionId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .maybeSingle();
  if (error) throw error;
  return (data as { external_id: string } | null)?.external_id ?? null;
}

// --- serialisation (same field names as the event payloads) ----------------------------

const CONTACT_COLUMNS = 'id, name, email, phone, company';
const TICKET_COLUMNS =
  'id, display_id, number, subject, description, category, status, priority, origin, conversation_id, channel_id, contact_id, assignee_id, opened_at, resolved_at, hubspot_ticket_id';
const CONVERSATION_COLUMNS =
  'id, subject, status, mode, priority, assignee_id, channel_id, contact_id, last_message_at, created_at';

async function loadContact(
  db: SupabaseClient,
  ctx: PublicApiContext,
  contactId: string | null
): Promise<Record<string, unknown> | null> {
  if (!contactId) return null;
  const { data, error } = await db
    .from('contacts')
    .select(CONTACT_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('id', contactId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const contact = data as unknown as Record<string, unknown>;
  return { ...contact, external_id: await externalIdOf(db, ctx, 'contact', contactId) };
}

async function loadTicket(
  db: SupabaseClient,
  ctx: PublicApiContext,
  ticketId: string
): Promise<{
  api: Record<string, unknown>;
  channelId: string;
  hubspotTicketId: string | null;
} | null> {
  const { data, error } = await db
    .from('tickets')
    .select(TICKET_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('id', ticketId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const {
    contact_id: contactId,
    hubspot_ticket_id: hubspotTicketId,
    ...ticket
  } = data as unknown as Record<string, unknown> & {
    contact_id: string | null;
    hubspot_ticket_id: string | null;
    channel_id: string;
  };
  return {
    api: {
      ...ticket,
      external_id: await externalIdOf(db, ctx, 'ticket', ticketId),
      contact: await loadContact(db, ctx, contactId),
    },
    channelId: ticket.channel_id,
    hubspotTicketId,
  };
}

// --- tickets ------------------------------------------------------------------------

export async function apiGetTicket(
  db: SupabaseClient,
  ctx: PublicApiContext,
  ref: string
): Promise<PublicApiResult> {
  const ticketId = await resolveRecordRef(db, ctx, 'ticket', ref);
  const ticket = ticketId ? await loadTicket(db, ctx, ticketId) : null;
  return ticket ? apiData({ ticket: ticket.api }) : NOT_FOUND('ticket');
}

const ticketPatchSchema = z
  .strictObject({
    status: ticketStatusSchema.optional(),
    priority: conversationPrioritySchema.optional(),
    category: z.string().trim().min(1).max(80).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);

export async function apiPatchTicket(
  db: SupabaseClient,
  ctx: PublicApiContext,
  ref: string,
  body: unknown
): Promise<PublicApiResult> {
  const parsed = ticketPatchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      422,
      'invalid_request',
      'body must contain at least one of: status (open|in_progress|waiting|resolved), priority (low|normal|high|urgent), category (string or null)'
    );
  }
  const ticketId = await resolveRecordRef(db, ctx, 'ticket', ref);
  if (!ticketId) return NOT_FOUND('ticket');

  const { data, error } = await db
    .from('tickets')
    .update(parsed.data)
    .eq('org_id', ctx.orgId)
    .eq('id', ticketId)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0) return NOT_FOUND('ticket');

  const ticket = await loadTicket(db, ctx, ticketId);
  if (!ticket) return NOT_FOUND('ticket');
  if (parsed.data.status === 'resolved') {
    // same follow-up as the "Erledigt" button in the app (Phase 11b); best-effort
    await requestTicketHubspotSync(db, {
      orgId: ctx.orgId,
      channelId: ticket.channelId,
      ticketId,
      alreadySynced: ticket.hubspotTicketId !== null,
    });
  }
  return apiData({ ticket: ticket.api });
}

// --- conversations ------------------------------------------------------------------

/** A conversation WITHOUT its messages — content stays in Zendori. */
export async function apiGetConversation(
  db: SupabaseClient,
  ctx: PublicApiContext,
  ref: string
): Promise<PublicApiResult> {
  const conversationId = await resolveRecordRef(db, ctx, 'conversation', ref);
  if (!conversationId) return NOT_FOUND('conversation');
  const { data, error } = await db
    .from('conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('org_id', ctx.orgId)
    .eq('id', conversationId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return NOT_FOUND('conversation');
  const {
    contact_id: contactId,
    channel_id: channelId,
    ...conversation
  } = data as unknown as Record<string, unknown> & {
    contact_id: string | null;
    channel_id: string;
  };
  const { data: channel, error: channelError } = await db
    .from('channels')
    .select('id, type, name')
    .eq('org_id', ctx.orgId)
    .eq('id', channelId)
    .maybeSingle();
  if (channelError) throw channelError;
  return apiData({
    conversation: {
      ...conversation,
      external_id: await externalIdOf(db, ctx, 'conversation', conversationId),
      channel: channel ?? null,
      contact: await loadContact(db, ctx, contactId),
    },
  });
}

// --- contacts -----------------------------------------------------------------------

export async function apiGetContact(
  db: SupabaseClient,
  ctx: PublicApiContext,
  ref: string
): Promise<PublicApiResult> {
  const contactId = await resolveRecordRef(db, ctx, 'contact', ref);
  const contact = contactId ? await loadContact(db, ctx, contactId) : null;
  return contact ? apiData({ contact }) : NOT_FOUND('contact');
}

const contactPatchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).nullable().optional(),
    email: z.string().trim().toLowerCase().max(320).pipe(z.email()).nullable().optional(),
    phone: z.string().trim().min(3).max(50).nullable().optional(),
    company: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);

export async function apiPatchContact(
  db: SupabaseClient,
  ctx: PublicApiContext,
  ref: string,
  body: unknown
): Promise<PublicApiResult> {
  const parsed = contactPatchSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      422,
      'invalid_request',
      'body must contain at least one of: name, email, phone, company (string or null)'
    );
  }
  const contactId = await resolveRecordRef(db, ctx, 'contact', ref);
  if (!contactId) return NOT_FOUND('contact');

  const { data, error } = await db
    .from('contacts')
    .update(parsed.data)
    .eq('org_id', ctx.orgId)
    .eq('id', contactId)
    .select('id');
  if (error) {
    // contacts_org_email_unique_idx: another contact of the org has this e-mail
    if ((error as { code?: string }).code === '23505') {
      return apiError(409, 'conflict', 'another contact already uses this e-mail address');
    }
    throw error;
  }
  if (!data || data.length === 0) return NOT_FOUND('contact');
  return apiData({ contact: await loadContact(db, ctx, contactId) });
}

// --- notes --------------------------------------------------------------------------

const noteSchema = z.strictObject({ content: z.string().trim().min(1).max(4000) });
const IDEMPOTENCY_KEY_MAX = 200;
/** Stored while the first request with an Idempotency-Key is still running. */
const IN_PROGRESS_STATUS = 0;

/**
 * Add an INTERNAL note (never sent to the customer) to a conversation, or to a
 * ticket's conversation. The note names the end system it came from. With an
 * Idempotency-Key a repeated request replays the first answer instead of
 * writing a second note.
 */
export async function apiAddNote(
  db: SupabaseClient,
  ctx: PublicApiContext,
  target: 'ticket' | 'conversation',
  ref: string,
  body: unknown,
  idempotencyKey: string | null
): Promise<PublicApiResult> {
  const parsed = noteSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(422, 'invalid_request', 'body must be { "content": "<1-4000 characters>" }');
  }
  const key = idempotencyKey?.trim() || null;
  if (key !== null && key.length > IDEMPOTENCY_KEY_MAX) {
    return apiError(422, 'invalid_request', 'Idempotency-Key is too long (max 200 characters)');
  }

  const recordId = await resolveRecordRef(db, ctx, target, ref);
  if (!recordId) return NOT_FOUND(target);

  let conversationId = recordId;
  if (target === 'ticket') {
    const { data, error } = await db
      .from('tickets')
      .select('conversation_id')
      .eq('org_id', ctx.orgId)
      .eq('id', recordId)
      .maybeSingle();
    if (error) throw error;
    const ticketConversation = (data as { conversation_id: string } | null)?.conversation_id;
    if (!ticketConversation) return NOT_FOUND('ticket');
    conversationId = ticketConversation;
  } else {
    const { data, error } = await db
      .from('conversations')
      .select('id')
      .eq('org_id', ctx.orgId)
      .eq('id', recordId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return NOT_FOUND('conversation');
  }

  // Claim the idempotency key BEFORE writing: the primary key makes the claim
  // atomic, so two concurrent requests with the same key cannot both write.
  if (key !== null) {
    const { error: claimError } = await db.from('api_idempotency_keys').insert({
      api_key_id: ctx.keyId,
      idempotency_key: key,
      org_id: ctx.orgId,
      response_status: IN_PROGRESS_STATUS,
      response_body: {},
    });
    if (claimError) {
      if ((claimError as { code?: string }).code !== '23505') throw claimError;
      const { data: stored, error: storedError } = await db
        .from('api_idempotency_keys')
        .select('response_status, response_body')
        .eq('api_key_id', ctx.keyId)
        .eq('idempotency_key', key)
        .maybeSingle();
      if (storedError) throw storedError;
      const first = stored as { response_status: number; response_body: unknown } | null;
      if (!first || first.response_status === IN_PROGRESS_STATUS) {
        return apiError(
          409,
          'conflict',
          'a request with this Idempotency-Key is still in progress'
        );
      }
      return { status: first.response_status, body: first.response_body };
    }
  }

  const { data: note, error: noteError } = await db
    .from('notes')
    .insert({
      org_id: ctx.orgId,
      conversation_id: conversationId,
      author_id: null,
      content: `[${ctx.connectionName}] ${parsed.data.content}`,
    })
    .select('id, created_at')
    .single();
  if (noteError) {
    if (key !== null) {
      // release the claim so the caller can retry with the same key
      await db
        .from('api_idempotency_keys')
        .delete()
        .eq('api_key_id', ctx.keyId)
        .eq('idempotency_key', key);
    }
    throw noteError;
  }
  if (target === 'ticket') {
    // the ticket timeline records THAT a note was added (content-free, §7)
    await db.from('ticket_events').insert({
      org_id: ctx.orgId,
      ticket_id: recordId,
      kind: 'note',
      actor_id: null,
      details: { source: 'api', connection_id: ctx.connectionId },
    });
  }

  const row = note as { id: string; created_at: string };
  const result = apiData(
    { note: { id: row.id, conversation_id: conversationId, created_at: row.created_at } },
    201
  );
  if (key !== null) {
    await db
      .from('api_idempotency_keys')
      .update({ response_status: result.status, response_body: result.body })
      .eq('api_key_id', ctx.keyId)
      .eq('idempotency_key', key);
  }
  return result;
}

// --- links --------------------------------------------------------------------------

const linkSchema = z.strictObject({
  entity_type: z.enum(['ticket', 'conversation', 'contact']),
  entity_id: z.uuid(),
  external_id: z.string().trim().min(1).max(200),
});

const ENTITY_TABLES: Record<LinkEntityType, string> = {
  ticket: 'tickets',
  conversation: 'conversations',
  contact: 'contacts',
};

/**
 * `PUT /api/v1/links` — tell Zendori the end system's own id for a record.
 * Idempotent: repeating the same link is a no-op, a new external id replaces
 * the old one. An external id can only point at ONE record per connection.
 */
export async function apiPutLink(
  db: SupabaseClient,
  ctx: PublicApiContext,
  body: unknown
): Promise<PublicApiResult> {
  const parsed = linkSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(
      422,
      'invalid_request',
      'body must be { "entity_type": "ticket|conversation|contact", "entity_id": "<uuid>", "external_id": "<1-200 characters>" }'
    );
  }
  const { entity_type: entityType, entity_id: entityId, external_id: externalId } = parsed.data;

  const { data: entity, error: entityError } = await db
    .from(ENTITY_TABLES[entityType])
    .select('id')
    .eq('org_id', ctx.orgId)
    .eq('id', entityId)
    .maybeSingle();
  if (entityError) throw entityError;
  if (!entity) return NOT_FOUND(entityType);

  const { data: existing, error: existingError } = await db
    .from('external_links')
    .select('id, external_id')
    .eq('org_id', ctx.orgId)
    .eq('connection_id', ctx.connectionId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .maybeSingle();
  if (existingError) throw existingError;
  const current = existing as { id: string; external_id: string } | null;

  const link = { entity_type: entityType, entity_id: entityId, external_id: externalId };
  if (current?.external_id === externalId) return apiData({ link });

  const write = current
    ? await db.from('external_links').update({ external_id: externalId }).eq('id', current.id)
    : await db.from('external_links').insert({
        org_id: ctx.orgId,
        connection_id: ctx.connectionId,
        ...link,
      });
  if (write.error) {
    if ((write.error as { code?: string }).code === '23505') {
      return apiError(409, 'conflict', 'this external_id is already linked to another record');
    }
    throw write.error;
  }
  return apiData({ link }, current ? 200 : 201);
}
