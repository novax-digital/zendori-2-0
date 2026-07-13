import { describe, expect, it } from 'vitest';
import { loadWebEnv, loadWorkerEnv } from '../src/env.js';

describe('env validation', () => {
  it('parses a valid web env', () => {
    const env = loadWebEnv({
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
    } as NodeJS.ProcessEnv);
    expect(env.APP_URL).toBe('http://localhost:3000');
  });

  it('rejects a worker env without session connection string', () => {
    expect(() =>
      loadWorkerEnv({
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'service-key',
      } as NodeJS.ProcessEnv)
    ).toThrow();
  });
});
