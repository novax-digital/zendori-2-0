import sodium from 'libsodium-wrappers';

const VERSION = 'v1';

async function keyFromBase64(keyBase64: string): Promise<Uint8Array> {
  await sodium.ready;
  let key: Uint8Array;
  try {
    key = sodium.from_base64(keyBase64, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new Error('MASTER_ENCRYPTION_KEY is not valid base64');
  }
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(
      `MASTER_ENCRYPTION_KEY must be ${sodium.crypto_secretbox_KEYBYTES} bytes (base64-encoded), got ${key.length}`
    );
  }
  return key;
}

/**
 * Encrypts a secret with libsodium secretbox (XSalsa20-Poly1305).
 * Output format: "v1:<base64 nonce>:<base64 ciphertext>".
 */
export async function encryptSecret(plaintext: string, keyBase64: string): Promise<string> {
  const key = await keyFromBase64(keyBase64);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, key);
  const b64 = sodium.base64_variants.ORIGINAL;
  return `${VERSION}:${sodium.to_base64(nonce, b64)}:${sodium.to_base64(ciphertext, b64)}`;
}

export async function decryptSecret(payload: string, keyBase64: string): Promise<string> {
  const key = await keyFromBase64(keyBase64);
  const [version, nonceB64, cipherB64] = payload.split(':');
  if (version !== VERSION || !nonceB64 || !cipherB64) {
    throw new Error('Invalid encrypted payload format');
  }
  const b64 = sodium.base64_variants.ORIGINAL;
  const plaintext = sodium.crypto_secretbox_open_easy(
    sodium.from_base64(cipherB64, b64),
    sodium.from_base64(nonceB64, b64),
    key
  );
  return sodium.to_string(plaintext);
}
