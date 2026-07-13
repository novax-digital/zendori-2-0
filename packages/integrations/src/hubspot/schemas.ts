// Zod response schemas + input/output types for the HubSpot client
// (docs/legacy-analysis.md §2.7). These are the only shapes the client relies
// on; HubSpot returns many extra fields, so object/search schemas passthrough.
import { z } from 'zod';

/**
 * The sole configuration passed to every HubSpot function. `token` is a HubSpot
 * Private-App token; it is only ever placed in the Authorization header and is
 * never logged or returned. `fetchImpl` lets tests inject a fake fetch (no real
 * network); `baseUrl` overrides the API host for the same reason.
 */
export interface HubSpotConfig {
  token: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

// --- priority mapping (§2.7) -------------------------------------------------

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export type HubSpotPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';

/** low→LOW, normal→MEDIUM, high→HIGH, urgent→URGENT (§2.7). */
export const PRIORITY_MAP: Record<TicketPriority, HubSpotPriority> = {
  low: 'LOW',
  normal: 'MEDIUM',
  high: 'HIGH',
  urgent: 'URGENT',
};

// --- input types -------------------------------------------------------------

/** v2 contacts have no company field (§2.7). */
export interface ContactInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface TicketDraft {
  subject: string;
  content: string;
  priority: TicketPriority;
  pipelineId: string;
  stageId: string;
  /** Stored as the zendori_source custom property. */
  sourceChannel: string;
  /** Idempotency anchor stored as the zendori_ref custom property (conversation UUID). */
  ref: string;
}

export interface NoteInput {
  body: string;
  sourceChannel: string;
  /** ISO timestamp used for the note's hs_timestamp. */
  occurredAt: string;
}

// --- output types ------------------------------------------------------------

export interface ContactRef {
  id: string;
}

export interface TicketRef {
  id: string;
}

export interface TicketPipeline {
  id: string;
  label: string;
  stages: { id: string; label: string }[];
}

export interface AccountInfo {
  portalId: number;
  uiDomain: string;
}

// --- response schemas --------------------------------------------------------

/** A single CRM object response (contacts/tickets/notes create/read). */
export const objectResponseSchema = z
  .object({
    id: z.string(),
    properties: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ObjectResponse = z.infer<typeof objectResponseSchema>;

/** A CRM search response. */
export const searchResponseSchema = z
  .object({
    total: z.number().optional(),
    results: z.array(objectResponseSchema),
  })
  .passthrough();
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** GET /crm/v3/pipelines/tickets. */
export const pipelinesResponseSchema = z
  .object({
    results: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          displayOrder: z.number().optional(),
          stages: z.array(
            z
              .object({
                id: z.string(),
                label: z.string(),
                displayOrder: z.number().optional(),
              })
              .passthrough()
          ),
        })
        .passthrough()
    ),
  })
  .passthrough();
export type PipelinesResponse = z.infer<typeof pipelinesResponseSchema>;

/** GET /account-info/v3/details. */
export const accountInfoResponseSchema = z
  .object({
    portalId: z.number(),
    uiDomain: z.string(),
  })
  .passthrough();
export type AccountInfoResponse = z.infer<typeof accountInfoResponseSchema>;
