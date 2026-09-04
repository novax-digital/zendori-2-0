import { describe, expect, it } from 'vitest';
import type { SyncRules } from '../src/schemas.js';
import { hubspotRuleApplies, parseHubspotSyncRules, ticketSyncWanted } from '../src/hubspot-rules.js';

const CHANNEL_A = '11111111-1111-4111-8111-111111111111';
const CHANNEL_B = '22222222-2222-4222-8222-222222222222';

describe('hubspotRuleApplies', () => {
  it("mode 'all' applies to every channel", () => {
    const rules: SyncRules = { mode: 'all' };
    expect(hubspotRuleApplies(rules, CHANNEL_A)).toBe(true);
    expect(hubspotRuleApplies(rules, CHANNEL_B)).toBe(true);
  });

  it("mode 'channels' applies only to listed channels (empty list never)", () => {
    expect(hubspotRuleApplies({ mode: 'channels', channel_ids: [CHANNEL_A] }, CHANNEL_A)).toBe(true);
    expect(hubspotRuleApplies({ mode: 'channels', channel_ids: [CHANNEL_A] }, CHANNEL_B)).toBe(false);
    expect(hubspotRuleApplies({ mode: 'channels', channel_ids: [] }, CHANNEL_A)).toBe(false);
  });

  it("mode 'manual' never applies automatically", () => {
    expect(hubspotRuleApplies({ mode: 'manual' }, CHANNEL_A)).toBe(false);
  });
});

describe('parseHubspotSyncRules (two streams, Phase 11b)', () => {
  it('reads the legacy flat shape as the conversation stream with tickets manual', () => {
    expect(parseHubspotSyncRules({ mode: 'all' })).toEqual({
      conversations: { mode: 'all' },
      tickets: { mode: 'manual' },
    });
  });

  it('reads the two-stream shape and fills missing streams with manual', () => {
    expect(
      parseHubspotSyncRules({
        conversations: { mode: 'manual' },
        tickets: { mode: 'channels', channel_ids: [CHANNEL_A] },
      })
    ).toEqual({
      conversations: { mode: 'manual' },
      tickets: { mode: 'channels', channel_ids: [CHANNEL_A] },
    });
    expect(parseHubspotSyncRules({ tickets: { mode: 'all' } })).toEqual({
      conversations: { mode: 'manual' },
      tickets: { mode: 'all' },
    });
  });

  it('degrades garbage to manual/manual', () => {
    expect(parseHubspotSyncRules(null)).toEqual({
      conversations: { mode: 'manual' },
      tickets: { mode: 'manual' },
    });
    expect(parseHubspotSyncRules({ mode: 'whatever' })).toEqual({
      conversations: { mode: 'manual' },
      tickets: { mode: 'manual' },
    });
  });
});

describe('ticketSyncWanted', () => {
  it('follows the rule, and always keeps an already-sent ticket in sync', () => {
    expect(ticketSyncWanted({ mode: 'manual' }, CHANNEL_A, false)).toBe(false);
    expect(ticketSyncWanted({ mode: 'manual' }, CHANNEL_A, true)).toBe(true);
    expect(ticketSyncWanted({ mode: 'all' }, CHANNEL_A, false)).toBe(true);
  });
});
