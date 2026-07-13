import { describe, expect, it } from 'vitest';
import {
  HubSpotAuthError,
  buildTicketDeepLink,
  getAccountInfo,
  listTicketPipelines,
} from '../src/index.js';
import { createMockFetch, mockConfig } from './helpers.js';

describe('getAccountInfo', () => {
  it('returns portalId + uiDomain', async () => {
    const { fetchImpl } = createMockFetch([
      { status: 200, body: { portalId: 12345, uiDomain: 'app-eu1.hubspot.com' } },
    ]);
    await expect(getAccountInfo(mockConfig(fetchImpl))).resolves.toEqual({
      portalId: 12345,
      uiDomain: 'app-eu1.hubspot.com',
    });
  });

  it('raises an invalid_token auth error on 401', async () => {
    const { fetchImpl } = createMockFetch([{ status: 401, body: { message: 'unauthorized' } }]);
    await expect(getAccountInfo(mockConfig(fetchImpl))).rejects.toBeInstanceOf(HubSpotAuthError);
    await expect(
      getAccountInfo(mockConfig(createMockFetch([{ status: 401 }]).fetchImpl))
    ).rejects.toMatchObject({ kind: 'invalid_token' });
  });

  it('raises a missing_scope auth error on 403', async () => {
    const { fetchImpl } = createMockFetch([{ status: 403, body: { message: 'forbidden' } }]);
    await expect(getAccountInfo(mockConfig(fetchImpl))).rejects.toMatchObject({
      kind: 'missing_scope',
    });
  });
});

describe('listTicketPipelines', () => {
  it('maps pipelines and sorts stages by displayOrder', async () => {
    const { fetchImpl } = createMockFetch([
      {
        status: 200,
        body: {
          results: [
            {
              id: 'pipe-1',
              label: 'Support Pipeline',
              stages: [
                { id: 's-2', label: 'In Bearbeitung', displayOrder: 2 },
                { id: 's-1', label: 'Neu', displayOrder: 1 },
                { id: 's-3', label: 'Gelöst', displayOrder: 3 },
              ],
            },
          ],
        },
      },
    ]);
    const pipelines = await listTicketPipelines(mockConfig(fetchImpl));
    expect(pipelines).toEqual([
      {
        id: 'pipe-1',
        label: 'Support Pipeline',
        stages: [
          { id: 's-1', label: 'Neu' },
          { id: 's-2', label: 'In Bearbeitung' },
          { id: 's-3', label: 'Gelöst' },
        ],
      },
    ]);
  });
});

describe('buildTicketDeepLink', () => {
  it('composes the ticket URL', () => {
    expect(
      buildTicketDeepLink({ uiDomain: 'app-eu1.hubspot.com', portalId: 12345, ticketId: 'tick-1' })
    ).toBe('https://app-eu1.hubspot.com/contacts/12345/ticket/tick-1');
  });
});
