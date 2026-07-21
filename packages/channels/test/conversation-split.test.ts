import { describe, expect, it } from 'vitest';
import { shouldStartNewConversation } from '../src/conversation-split.js';

const NOW = new Date('2026-07-21T12:00:00.000Z');

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
}

describe('shouldStartNewConversation', () => {
  it('never splits when no window is configured', () => {
    const candidate = { status: 'open', lastMessageAt: hoursAgo(1000) };
    expect(shouldStartNewConversation(candidate, undefined, NOW)).toBe(false);
    expect(shouldStartNewConversation(candidate, null, NOW)).toBe(false);
    expect(shouldStartNewConversation(candidate, 0, NOW)).toBe(false);
    expect(shouldStartNewConversation(candidate, -5, NOW)).toBe(false);
    expect(shouldStartNewConversation(candidate, Number.NaN, NOW)).toBe(false);
  });

  it('splits an open conversation once the window is exceeded', () => {
    expect(
      shouldStartNewConversation({ status: 'open', lastMessageAt: hoursAgo(73) }, 72, NOW)
    ).toBe(true);
  });

  it('does not split within the window (boundary is exclusive)', () => {
    expect(
      shouldStartNewConversation({ status: 'open', lastMessageAt: hoursAgo(71) }, 72, NOW)
    ).toBe(false);
    // exactly at the boundary: not yet "more than" the window
    expect(
      shouldStartNewConversation({ status: 'open', lastMessageAt: hoursAgo(72) }, 72, NOW)
    ).toBe(false);
  });

  it('NEVER splits a pending conversation (waiting handoff/callback queue)', () => {
    expect(
      shouldStartNewConversation({ status: 'pending', lastMessageAt: hoursAgo(10_000) }, 24, NOW)
    ).toBe(false);
  });

  it('splits a resolved conversation past the window (widget resume path)', () => {
    expect(
      shouldStartNewConversation({ status: 'resolved', lastMessageAt: hoursAgo(25) }, 24, NOW)
    ).toBe(true);
  });

  it('keeps a resolved conversation within the window (friendly "Danke!" case)', () => {
    expect(
      shouldStartNewConversation({ status: 'resolved', lastMessageAt: hoursAgo(2) }, 24, NOW)
    ).toBe(false);
  });

  it('never splits on missing or unparsable timestamps', () => {
    expect(shouldStartNewConversation({ status: 'open', lastMessageAt: null }, 24, NOW)).toBe(
      false
    );
    expect(
      shouldStartNewConversation({ status: 'open', lastMessageAt: 'not-a-date' }, 24, NOW)
    ).toBe(false);
  });
});
