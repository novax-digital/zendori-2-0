import { describe, expect, it } from 'vitest';
import {
  channelTypeSchema,
  conversationModeSchema,
  messageSchema,
  syncRulesSchema,
} from '../src/schemas.js';

describe('domain schemas', () => {
  it('accepts valid channel types and rejects unknown ones', () => {
    expect(channelTypeSchema.parse('email')).toBe('email');
    expect(() => channelTypeSchema.parse('sms')).toThrow();
  });

  it('conversation mode defaults are bot|human only', () => {
    expect(conversationModeSchema.parse('bot')).toBe('bot');
    expect(() => conversationModeSchema.parse('auto')).toThrow();
  });

  it('parses a full message row', () => {
    const row = {
      id: '3f1e9c1a-2b4d-4f6a-8c9e-1a2b3c4d5e6f',
      org_id: '3f1e9c1a-2b4d-4f6a-8c9e-1a2b3c4d5e6f',
      conversation_id: '3f1e9c1a-2b4d-4f6a-8c9e-1a2b3c4d5e6f',
      channel_id: '3f1e9c1a-2b4d-4f6a-8c9e-1a2b3c4d5e6f',
      direction: 'in',
      sender_type: 'contact',
      content: 'Hallo, ich habe eine Frage.',
      content_type: 'text',
      external_id: 'resend-abc-123',
      metadata: {},
      processing_state: 'pending',
      created_at: '2026-07-13T12:00:00Z',
    };
    expect(messageSchema.parse(row)).toEqual(row);
  });

  it('validates sync rules as discriminated union', () => {
    expect(syncRulesSchema.parse({ mode: 'all' })).toEqual({ mode: 'all' });
    expect(
      syncRulesSchema.parse({
        mode: 'channels',
        channel_ids: ['3f1e9c1a-2b4d-4f6a-8c9e-1a2b3c4d5e6f'],
      }).mode
    ).toBe('channels');
    expect(() => syncRulesSchema.parse({ mode: 'channels' })).toThrow();
    expect(() => syncRulesSchema.parse({ mode: 'everything' })).toThrow();
  });
});
