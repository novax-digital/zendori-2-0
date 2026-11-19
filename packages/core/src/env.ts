import { z } from 'zod';

export const webEnvSchema = z.object({
  APP_URL: z.url().default('http://localhost:3000'),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  MASTER_ENCRYPTION_KEY: z.string().min(1).optional(),
});
export type WebEnv = z.infer<typeof webEnvSchema>;

/** Optional env var where an empty string (`FOO=` in a .env file) means "unset". */
function optionalEnv<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

export const workerEnvSchema = z.object({
  DATABASE_URL_SESSION: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  MASTER_ENCRYPTION_KEY: z.string().min(1).optional(),
  /** xAI voice (Phase 9) — absent disables the voice dispatch entirely. */
  XAI_API_KEY: z.string().min(1).optional(),
  XAI_API_BASE: z.string().optional(),
  VOICE_MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().optional(),
  /** Operator Twilio creds — call recording, demo calls, number provisioning (0033). */
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  /**
   * Number provisioning (0033, Admin → Telefonnummern): Elastic SIP trunk the
   * bought numbers are attached to + one regulatory bundle per DE number type
   * (legacy TWILIO_BUNDLE_SID = fallback). Missing ones fail the approved row
   * with the variable names — the worker itself starts regardless.
   */
  TWILIO_VOICE_TRUNK_SID: optionalEnv(z.string().min(1)),
  TWILIO_BUNDLE_SID: optionalEnv(z.string().min(1)),
  TWILIO_BUNDLE_SID_LOCAL: optionalEnv(z.string().min(1)),
  TWILIO_BUNDLE_SID_MOBILE: optionalEnv(z.string().min(1)),
  TWILIO_BUNDLE_SID_NATIONAL: optionalEnv(z.string().min(1)),
  /** Overrides the AddressSid derived from the local bundle (Twilio 21631). */
  TWILIO_ADDRESS_SID_LOCAL: optionalEnv(z.string().min(1)),
  /** Public https app URL — xAI webhook of provisioned numbers, links in mails. */
  APP_URL: optionalEnv(z.string().min(1)),
  LOG_LEVEL: z.string().optional(),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWebEnv(source: NodeJS.ProcessEnv = process.env): WebEnv {
  return webEnvSchema.parse(source);
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return workerEnvSchema.parse(source);
}
