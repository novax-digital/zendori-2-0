import type { StoredSession } from './types';

/**
 * localStorage helpers with an in-memory fallback (Safari private mode,
 * disabled storage, sandboxed iframes). Keys are namespaced per widget token
 * so multiple widgets on one origin do not collide.
 */

const memoryFallback = new Map<string, string>();

function readItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

function writeItem(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    memoryFallback.set(key, value);
  }
}

function removeItem(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    memoryFallback.delete(key);
  }
}

/**
 * Storage id of a widget in Zendori's own "Test" tab (0050): the test keeps a
 * session of its own, apart from a real visitor session in the same browser.
 */
export function testStorageId(token: string): string {
  return `test-${token}`;
}

/** Every key the widget may keep for one storage id — what "start over" clears. */
export function widgetStorageKeys(id: string): string[] {
  return [sessionKey(id), contactPromptKey(id), teaserKey(id)];
}

function sessionKey(token: string): string {
  return `zendori-widget-${token}`;
}

function contactPromptKey(token: string): string {
  return `zendori-widget-${token}:contact-done`;
}

export function loadStoredSession(token: string): StoredSession | null {
  const raw = readItem(sessionKey(token));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { conversationId?: unknown }).conversationId === 'string' &&
      typeof (parsed as { secret?: unknown }).secret === 'string'
    ) {
      const value = parsed as { conversationId: string; secret: string };
      return { conversationId: value.conversationId, secret: value.secret };
    }
  } catch {
    // corrupt entry — treated like no session below
  }
  removeItem(sessionKey(token));
  return null;
}

export function saveStoredSession(token: string, session: StoredSession): void {
  writeItem(sessionKey(token), JSON.stringify(session));
}

export function clearStoredSession(token: string): void {
  removeItem(sessionKey(token));
}

function teaserKey(token: string): string {
  return `zendori-widget-${token}:teaser-dismissed`;
}

/** The teaser was shown (or closed) — do not invite again in this browser. */
export function isTeaserDismissed(token: string): boolean {
  return readItem(teaserKey(token)) === '1';
}

export function markTeaserDismissed(token: string): void {
  writeItem(teaserKey(token), '1');
}

export function isContactPromptDone(token: string): boolean {
  return readItem(contactPromptKey(token)) === '1';
}

export function markContactPromptDone(token: string): void {
  writeItem(contactPromptKey(token), '1');
}
