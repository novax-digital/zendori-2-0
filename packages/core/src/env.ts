import { z } from 'zod';

export const webEnvSchema = z.object({
  APP_URL: z.url().default('http://localhost:3000'),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  MASTER_ENCRYPTION_KEY: z.string().min(1).optional(),
});
export type WebEnv = z.infer<typeof webEnvSchema>;

export const workerEnvSchema = z.object({
  DATABASE_URL_SESSION: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  MASTER_ENCRYPTION_KEY: z.string().min(1).optional(),
  LOG_LEVEL: z.string().optional(),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWebEnv(source: NodeJS.ProcessEnv = process.env): WebEnv {
  return webEnvSchema.parse(source);
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return workerEnvSchema.parse(source);
}
