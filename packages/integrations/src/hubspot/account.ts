// Account info + ticket pipelines (docs/legacy-analysis.md §2.7). Used to verify
// a Private-App token (account-info + pipelines) and to build ticket deep links.
import { isSuccess, parseJson, request, requestFailed } from './client.js';
import {
  accountInfoResponseSchema,
  pipelinesResponseSchema,
  type AccountInfo,
  type HubSpotConfig,
  type TicketPipeline,
} from './schemas.js';

const ACCOUNT_INFO_PATH = '/account-info/v3/details';
const PIPELINES_PATH = '/crm/v3/pipelines/tickets';

/**
 * Fetch portal id + UI domain. A 401 → HubSpotAuthError(kind: invalid_token),
 * a 403 → HubSpotAuthError(kind: missing_scope) (via requestFailed), so a caller
 * can show a precise German hint.
 */
export async function getAccountInfo(config: HubSpotConfig): Promise<AccountInfo> {
  const res = await request(config, 'GET', ACCOUNT_INFO_PATH);
  if (!isSuccess(res.status)) throw requestFailed('GET', ACCOUNT_INFO_PATH, res);
  const parsed = parseJson(accountInfoResponseSchema, res, 'GET', ACCOUNT_INFO_PATH);
  return { portalId: parsed.portalId, uiDomain: parsed.uiDomain };
}

/** List ticket pipelines with their stages, stages sorted by displayOrder. */
export async function listTicketPipelines(config: HubSpotConfig): Promise<TicketPipeline[]> {
  const res = await request(config, 'GET', PIPELINES_PATH);
  if (!isSuccess(res.status)) throw requestFailed('GET', PIPELINES_PATH, res);
  const parsed = parseJson(pipelinesResponseSchema, res, 'GET', PIPELINES_PATH);
  return parsed.results.map((pipeline) => ({
    id: pipeline.id,
    label: pipeline.label,
    stages: [...pipeline.stages]
      .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
      .map((stage) => ({ id: stage.id, label: stage.label })),
  }));
}

/** Build a HubSpot ticket deep link from account-info + a ticket id (§2.7). */
export function buildTicketDeepLink(input: {
  uiDomain: string;
  portalId: number | string;
  ticketId: string;
}): string {
  return `https://${input.uiDomain}/contacts/${input.portalId}/ticket/${input.ticketId}`;
}
