import { randomBytes } from 'node:crypto';

/**
 * Intake-address provisioning. Generates non-guessable per-source addresses of
 * the form {slug}-{purpose}-{token}@{INBOUND_EMAIL_DOMAIN} that map 1:1 to an
 * inbound-email channel (Resend catch-all → email.received webhook → routing).
 */

/** Max length per label so the local part stays well under the 64-char RFC limit. */
const MAX_LABEL_LENGTH = 24;

function inboundDomain(): string {
  // Domains are case-insensitive; normalize to lowercase for stable addresses.
  const domain = process.env.INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!domain) throw new Error('INBOUND_EMAIL_DOMAIN is not set');
  return domain;
}

/**
 * Lowercases and reduces a free-text label to an address-safe slug:
 * strips accents (ä → a), collapses every non [a-z0-9] run to a single '-',
 * and trims leading/trailing dashes.
 */
export function slugifyPurpose(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '') // strip combining diacritical marks left by NFKD
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Builds a fresh, non-guessable intake address for an org slug + purpose label. */
export function generateIntakeAddress(slug: string, purpose: string): string {
  const domain = inboundDomain();
  const slugLabel = slugifyPurpose(slug).slice(0, MAX_LABEL_LENGTH) || 'org';
  const purposeLabel = slugifyPurpose(purpose).slice(0, MAX_LABEL_LENGTH) || 'intake';
  const token = randomBytes(8).toString('hex'); // 16 hex chars, non-guessable
  return `${slugLabel}-${purposeLabel}-${token}@${domain}`;
}
