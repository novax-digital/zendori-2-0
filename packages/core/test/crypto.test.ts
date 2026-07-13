import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../src/crypto.js';

const key = randomBytes(32).toString('base64');

describe('crypto (libsodium secretbox)', () => {
  it('round-trips a secret', async () => {
    const encrypted = await encryptSecret('imap-password-123', key);
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(encrypted).not.toContain('imap-password-123');
    const decrypted = await decryptSecret(encrypted, key);
    expect(decrypted).toBe('imap-password-123');
  });

  it('produces different ciphertexts for the same plaintext (random nonce)', async () => {
    const a = await encryptSecret('same', key);
    const b = await encryptSecret('same', key);
    expect(a).not.toBe(b);
  });

  it('fails to decrypt with the wrong key', async () => {
    const encrypted = await encryptSecret('secret', key);
    const wrongKey = randomBytes(32).toString('base64');
    await expect(decryptSecret(encrypted, wrongKey)).rejects.toThrow();
  });

  it('rejects keys with wrong length', async () => {
    const shortKey = randomBytes(16).toString('base64');
    await expect(encryptSecret('secret', shortKey)).rejects.toThrow(/32 bytes/);
  });

  it('rejects malformed payloads', async () => {
    await expect(decryptSecret('not-a-valid-payload', key)).rejects.toThrow(/format/);
  });
});
