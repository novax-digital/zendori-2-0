import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@zendori/core';
import type { suggestAgentIdentity } from '@zendori/ai';
import {
  AGENT_PROMPT_KEEP_MS,
  AGENT_PROMPT_MAX_AGE_MS,
  AGENT_PROMPT_STALE_MS,
  failStaleAgentPrompts,
  processAgentPrompt,
  pruneAgentPrompts,
} from '../src/pipeline/agent-prompt.js';
import { createMemoryDb, type MemoryDb } from './memory-supabase.js';

// Migration 0049: the suggested identity of the agent editor. Pins that a
// request is answered exactly once, that the paid call is never repeated, and
// that a request always ends — the editor is waiting on the row.

const ORG = '11111111-1111-4111-8111-111111111111';
const REQUEST = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-27T10:00:00Z');
const logger = createLogger('test', 'silent');

type Suggest = typeof suggestAgentIdentity;

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REQUEST,
    org_id: ORG,
    requested_by: 'u-owner',
    agent_kind: 'text',
    agent_name: 'Lisa',
    notes: 'Kundenservice für Solaranlagen, duzen, keine Preise nennen',
    current_identity: null,
    state: 'queued',
    result: null,
    error_code: null,
    created_at: new Date(NOW - 2_000).toISOString(),
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

function setup(row: Record<string, unknown> = request()): MemoryDb {
  return createMemoryDb({
    agent_prompt_requests: [row],
    organizations: [{ id: ORG, name: 'Strong Energy GmbH' }],
  });
}

const answer = (text: string): Suggest =>
  vi.fn<Suggest>(async () => ({
    result: text,
    usage: { inputTokens: 600, outputTokens: 300 },
    costUsd: 0.0063,
  }));

describe('suggested agent identity', () => {
  it('writes the suggestion into the request, with the company from the database', async () => {
    const db = setup();
    const suggest = answer('Du bist Lisa, die Support-Assistentin von Strong Energy.');
    await processAgentPrompt({ supabase: db.client, logger, suggest, now: () => NOW }, REQUEST);

    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenCalledWith({
      companyName: 'Strong Energy GmbH',
      agentKind: 'text',
      agentName: 'Lisa',
      notes: 'Kundenservice für Solaranlagen, duzen, keine Preise nennen',
      currentIdentity: null,
    });
    const row = db.rows('agent_prompt_requests')[0]!;
    expect(row.state).toBe('succeeded');
    expect(row.result).toBe('Du bist Lisa, die Support-Assistentin von Strong Energy.');
    expect(row.error_code).toBeNull();
    expect(row.model).toBe('claude-sonnet-4-6');
    expect(row.cost_usd).toBe(0.0063);
    expect(row.started_at).toBe(new Date(NOW).toISOString());
    expect(row.finished_at).toBe(new Date(NOW).toISOString());
  });

  it('passes the kind of a voice agent and the identity to rework', async () => {
    const db = setup(request({ agent_kind: 'voice', current_identity: 'Du bist Max.' }));
    const suggest = answer('Du bist Max und sprichst in kurzen Sätzen.');
    await processAgentPrompt({ supabase: db.client, logger, suggest, now: () => NOW }, REQUEST);
    expect(suggest).toHaveBeenCalledWith(
      expect.objectContaining({ agentKind: 'voice', currentIdentity: 'Du bist Max.' })
    );
  });

  it('answers a request once: a second job finds nothing to do', async () => {
    const db = setup();
    const suggest = answer('Du bist Lisa.');
    const deps = { supabase: db.client, logger, suggest, now: () => NOW };
    await processAgentPrompt(deps, REQUEST);
    await processAgentPrompt(deps, REQUEST);
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it('leaves alone what is not queued', async () => {
    for (const state of ['running', 'succeeded', 'failed']) {
      const db = setup(request({ state, result: state === 'succeeded' ? 'alt' : null }));
      const suggest = answer('neu');
      await processAgentPrompt({ supabase: db.client, logger, suggest, now: () => NOW }, REQUEST);
      expect(suggest).not.toHaveBeenCalled();
      expect(db.rows('agent_prompt_requests')[0]!.state).toBe(state);
    }
  });

  it('a failed call ends the request and is not repeated', async () => {
    const db = setup();
    const suggest = vi.fn<Suggest>(async () => {
      throw new Error('529 overloaded');
    });
    const deps = { supabase: db.client, logger, suggest, now: () => NOW };
    await expect(processAgentPrompt(deps, REQUEST)).resolves.toBeUndefined();
    const row = db.rows('agent_prompt_requests')[0]!;
    expect(row.state).toBe('failed');
    expect(row.error_code).toBe('ai_failed');
    expect(row.result).toBeNull();
    expect(row.finished_at).toBe(new Date(NOW).toISOString());

    await processAgentPrompt(deps, REQUEST);
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it('names a missing key and an empty answer', async () => {
    const cases: [string, string][] = [
      ['ANTHROPIC_API_KEY ist nicht gesetzt.', 'not_configured'],
      ['Der Vorschlag für die Identität war leer.', 'empty_result'],
    ];
    for (const [message, code] of cases) {
      const db = setup();
      const suggest = vi.fn<Suggest>(async () => {
        throw new Error(message);
      });
      await processAgentPrompt({ supabase: db.client, logger, suggest, now: () => NOW }, REQUEST);
      expect(db.rows('agent_prompt_requests')[0]!.error_code).toBe(code);
    }
  });

  it('does not pay for a request nobody waits for any more', async () => {
    const db = setup(
      request({ created_at: new Date(NOW - AGENT_PROMPT_MAX_AGE_MS - 1_000).toISOString() })
    );
    const suggest = answer('zu spät');
    await processAgentPrompt({ supabase: db.client, logger, suggest, now: () => NOW }, REQUEST);
    expect(suggest).not.toHaveBeenCalled();
    const row = db.rows('agent_prompt_requests')[0]!;
    expect(row.state).toBe('failed');
    expect(row.error_code).toBe('expired');
  });

  it('does not overwrite a request the sweep closed while the call was running', async () => {
    const db = setup();
    const suggest = vi.fn<Suggest>(async () => {
      // the stale sweep closes the request while the model is still writing
      Object.assign(db.rows('agent_prompt_requests')[0]!, { state: 'failed', error_code: 'stale' });
      return { result: 'zu spät', usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 0 };
    });
    await processAgentPrompt({ supabase: db.client, logger, suggest, now: () => NOW }, REQUEST);
    const row = db.rows('agent_prompt_requests')[0]!;
    expect(row.state).toBe('failed');
    expect(row.error_code).toBe('stale');
    expect(row.result).toBeNull();
  });

  it('still answers when the organization has no name', async () => {
    const db = createMemoryDb({ agent_prompt_requests: [request()], organizations: [] });
    const suggest = answer('Du bist Lisa.');
    await processAgentPrompt({ supabase: db.client, logger, suggest, now: () => NOW }, REQUEST);
    expect(suggest).toHaveBeenCalledWith(expect.objectContaining({ companyName: 'dem Unternehmen' }));
    expect(db.rows('agent_prompt_requests')[0]!.state).toBe('succeeded');
  });
});

describe('housekeeping of identity requests', () => {
  it('closes requests whose worker died, and only those', async () => {
    const db = createMemoryDb({
      agent_prompt_requests: [
        request({
          id: 'old',
          state: 'running',
          started_at: new Date(NOW - AGENT_PROMPT_STALE_MS - 1_000).toISOString(),
        }),
        request({ id: 'fresh', state: 'running', started_at: new Date(NOW - 10_000).toISOString() }),
        request({ id: 'queued', state: 'queued' }),
      ],
    });
    await failStaleAgentPrompts(db.client, NOW);
    const state = (id: string) => db.rows('agent_prompt_requests').find((row) => row.id === id)!;
    expect(state('old').state).toBe('failed');
    expect(state('old').error_code).toBe('stale');
    expect(state('fresh').state).toBe('running');
    expect(state('queued').state).toBe('queued');
  });

  it('deletes requests after a week', async () => {
    const db = createMemoryDb({
      agent_prompt_requests: [
        request({ id: 'old', created_at: new Date(NOW - AGENT_PROMPT_KEEP_MS - 1_000).toISOString() }),
        request({ id: 'recent', created_at: new Date(NOW - 60_000).toISOString() }),
      ],
    });
    await pruneAgentPrompts(db.client, NOW);
    expect(db.rows('agent_prompt_requests').map((row) => row.id)).toEqual(['recent']);
  });
});
