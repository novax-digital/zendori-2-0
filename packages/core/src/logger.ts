import { pino } from 'pino';
import type { Logger } from 'pino';

// GDPR: message contents and contact data must never appear in logs.
const REDACT_PATHS = [
  'content',
  '*.content',
  'body',
  '*.body',
  'html',
  '*.html',
  'text',
  '*.text',
  'email',
  '*.email',
  'phone',
  '*.phone',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function createLogger(name: string, level?: string): Logger {
  return pino({
    name,
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  });
}

export type { Logger };
