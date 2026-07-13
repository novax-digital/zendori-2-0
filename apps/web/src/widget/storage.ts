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

export function isContactPromptDone(token: string): boolean {
  return readItem(contactPromptKey(token)) === '1';
}

export function markContactPromptDone(token: string): void {
  writeItem(contactPromptKey(token), '1');
}
