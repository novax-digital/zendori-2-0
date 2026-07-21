import { describe, expect, it } from 'vitest';
import { issueRenderToken, verifyRenderToken } from '../src/form/render-token.js';

const MASTER = Buffer.from('0'.repeat(32)).toString('base64');
const OTHER_MASTER = Buffer.from('1'.repeat(32)).toString('base64');
const FORM_TOKEN = 'a'.repeat(32);

describe('render token', () => {
  it('verifies a token within the valid window', () => {
    const issued = new Date('2026-07-21T10:00:00Z');
    const token = issueRenderToken(MASTER, FORM_TOKEN, issued);
    const later = new Date(issued.getTime() + 10_000);
    expect(verifyRenderToken(MASTER, FORM_TOKEN, token, later)).toBe('ok');
  });

  it('rejects submits faster than the min-time (bot signature)', () => {
    const issued = new Date('2026-07-21T10:00:00Z');
    const token = issueRenderToken(MASTER, FORM_TOKEN, issued);
    const tooSoon = new Date(issued.getTime() + 1_000);
    expect(verifyRenderToken(MASTER, FORM_TOKEN, token, tooSoon)).toBe('too_fast');
  });

  it('expires after 24h', () => {
    const issued = new Date('2026-07-21T10:00:00Z');
    const token = issueRenderToken(MASTER, FORM_TOKEN, issued);
    const tooLate = new Date(issued.getTime() + 25 * 60 * 60 * 1000);
    expect(verifyRenderToken(MASTER, FORM_TOKEN, token, tooLate)).toBe('expired');
  });

  it('rejects tampered tokens, foreign forms and foreign keys', () => {
    const issued = new Date('2026-07-21T10:00:00Z');
    const later = new Date(issued.getTime() + 10_000);
    const token = issueRenderToken(MASTER, FORM_TOKEN, issued);

    expect(verifyRenderToken(MASTER, 'b'.repeat(32), token, later)).toBe('invalid');
    expect(verifyRenderToken(OTHER_MASTER, FORM_TOKEN, token, later)).toBe('invalid');
    const tampered = token.replace(/\.\d+\./, `.${Date.now()}.`);
    expect(verifyRenderToken(MASTER, FORM_TOKEN, tampered, later)).toBe('invalid');
    expect(verifyRenderToken(MASTER, FORM_TOKEN, 'garbage', later)).toBe('invalid');
    expect(verifyRenderToken(MASTER, FORM_TOKEN, 'v1.abc.def', later)).toBe('invalid');
  });
});
