import { describe, expect, it } from 'vitest';
import {
  TICKET_TO_CONTACT_TYPE_ID,
  createTicket,
  findTicketByRef,
  updateTicketStage,
  type TicketDraft,
} from '../src/index.js';
import { createMockFetch, mockConfig } from './helpers.js';

function draft(overrides: Partial<TicketDraft> = {}): TicketDraft {
  return {
    subject: 'Anfrage',
    content: 'Hallo, ich habe eine Frage.',
    priority: 'urgent',
    pipelineId: 'pipe-1',
    stageId: 'stage-1',
    sourceChannel: 'email',
    ref: 'conv-uuid-1',
    ...overrides,
  };
}

describe('createTicket', () => {
  it('sends the mapped properties + contact association', async () => {
    const { fetchImpl, requests } = createMockFetch([{ status: 201, body: { id: 'tick-1' } }]);
    const ref = await createTicket(mockConfig(fetchImpl), draft({ priority: 'high' }), 'contact-9');
    expect(ref).toEqual({ id: 'tick-1' });

    const body = requests[0]?.body as {
      properties: Record<string, unknown>;
      associations: {
        to: { id: string };
        types: { associationCategory: string; associationTypeId: number }[];
      }[];
    };
    expect(body.properties).toEqual({
      subject: 'Anfrage',
      content: 'Hallo, ich habe eine Frage.',
      hs_pipeline: 'pipe-1',
      hs_pipeline_stage: 'stage-1',
      hs_ticket_priority: 'HIGH',
      zendori_source: 'email',
      zendori_ref: 'conv-uuid-1',
    });
    expect(body.associations[0]?.to.id).toBe('contact-9');
    expect(body.associations[0]?.types[0]).toEqual({
      associationCategory: 'HUBSPOT_DEFINED',
      associationTypeId: TICKET_TO_CONTACT_TYPE_ID,
    });
  });

  it('maps urgent → URGENT', async () => {
    const { fetchImpl, requests } = createMockFetch([{ status: 201, body: { id: 't' } }]);
    await createTicket(mockConfig(fetchImpl), draft({ priority: 'urgent' }), 'c1');
    const body = requests[0]?.body as { properties: Record<string, unknown> };
    expect(body.properties.hs_ticket_priority).toBe('URGENT');
  });

  it('degrades URGENT → HIGH once on a 400 priority error', async () => {
    const { fetchImpl, requests } = createMockFetch([
      { status: 400, body: { message: 'Property hs_ticket_priority: URGENT not a valid option' } },
      { status: 201, body: { id: 'tick-degraded' } },
    ]);
    const ref = await createTicket(mockConfig(fetchImpl), draft({ priority: 'urgent' }), 'c1');
    expect(ref).toEqual({ id: 'tick-degraded' });
    expect(requests).toHaveLength(2);
    const retryBody = requests[1]?.body as { properties: Record<string, unknown> };
    expect(retryBody.properties.hs_ticket_priority).toBe('HIGH');
  });

  it('does not degrade a non-priority 400', async () => {
    const { fetchImpl, requests } = createMockFetch([
      { status: 400, body: { message: 'Property subject is required' } },
    ]);
    await expect(
      createTicket(mockConfig(fetchImpl), draft({ priority: 'urgent' }), 'c1')
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(1);
  });

  it('does not degrade when priority is already HIGH', async () => {
    const { fetchImpl, requests } = createMockFetch([
      { status: 400, body: { message: 'priority invalid' } },
    ]);
    await expect(
      createTicket(mockConfig(fetchImpl), draft({ priority: 'high' }), 'c1')
    ).rejects.toMatchObject({ status: 400 });
    expect(requests).toHaveLength(1);
  });
});

describe('updateTicketStage', () => {
  it('PATCHes the pipeline stage', async () => {
    const { fetchImpl, requests } = createMockFetch([{ status: 200, body: { id: 't' } }]);
    await updateTicketStage(mockConfig(fetchImpl), 'tick-1', 'stage-resolved');
    expect(requests[0]?.method).toBe('PATCH');
    expect(requests[0]?.url).toContain('/crm/v3/objects/tickets/tick-1');
    expect(requests[0]?.body).toEqual({ properties: { hs_pipeline_stage: 'stage-resolved' } });
  });
});

describe('findTicketByRef', () => {
  it('returns the id on 200', async () => {
    const { fetchImpl, requests } = createMockFetch([{ status: 200, body: { id: 'tick-1' } }]);
    await expect(findTicketByRef(mockConfig(fetchImpl), 'conv-1')).resolves.toEqual({
      id: 'tick-1',
    });
    expect(requests[0]?.url).toContain('idProperty=zendori_ref');
  });

  it('returns null on 404', async () => {
    const { fetchImpl } = createMockFetch([{ status: 404, body: { message: 'not found' } }]);
    await expect(findTicketByRef(mockConfig(fetchImpl), 'conv-1')).resolves.toBeNull();
  });

  it('falls back to search on 400', async () => {
    const { fetchImpl, requests } = createMockFetch([
      { status: 400, body: { message: 'idProperty not indexed yet' } },
      { status: 200, body: { results: [{ id: 'tick-searched' }] } },
    ]);
    await expect(findTicketByRef(mockConfig(fetchImpl), 'conv-1')).resolves.toEqual({
      id: 'tick-searched',
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toContain('/crm/v3/objects/tickets/search');
  });

  it('returns null when the 400 search fallback finds nothing', async () => {
    const { fetchImpl } = createMockFetch([
      { status: 400, body: {} },
      { status: 200, body: { results: [] } },
    ]);
    await expect(findTicketByRef(mockConfig(fetchImpl), 'conv-1')).resolves.toBeNull();
  });
});
