import { describe, expect, it } from 'vitest';
import type { SyncRules } from '@zendori/core';
import { hubspotRuleApplies } from '../src/pipeline/process-message.js';

const CHANNEL_A = '11111111-1111-4111-8111-111111111111';
const CHANNEL_B = '22222222-2222-4222-8222-222222222222';

describe('hubspotRuleApplies', () => {
  it("mode 'all' applies to every channel", () => {
    const rules: SyncRules = { mode: 'all' };
    expect(hubspotRuleApplies(rules, CHANNEL_A)).toBe(true);
    expect(hubspotRuleApplies(rules, CHANNEL_B)).toBe(true);
  });

  it("mode 'channels' applies only to listed channels", () => {
    const rules: SyncRules = { mode: 'channels', channel_ids: [CHANNEL_A] };
    expect(hubspotRuleApplies(rules, CHANNEL_A)).toBe(true);
    expect(hubspotRuleApplies(rules, CHANNEL_B)).toBe(false);
  });

  it("mode 'channels' with an empty list never applies", () => {
    const rules: SyncRules = { mode: 'channels', channel_ids: [] };
    expect(hubspotRuleApplies(rules, CHANNEL_A)).toBe(false);
  });

  it("mode 'manual' never applies automatically", () => {
    const rules: SyncRules = { mode: 'manual' };
    expect(hubspotRuleApplies(rules, CHANNEL_A)).toBe(false);
    expect(hubspotRuleApplies(rules, CHANNEL_B)).toBe(false);
  });
});
