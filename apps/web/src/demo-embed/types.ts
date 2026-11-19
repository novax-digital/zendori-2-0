// Demo-Anruf embed types (demo.js). Hand-rolled (no zod in the browser
// bundle); the server validates every input with zod (@zendori/core demo.ts).

export type DemoFieldKey =
  | 'company'
  | 'contactName'
  | 'email'
  | 'phone'
  | 'websiteUrl'
  | 'prompt'
  | 'consent';

export type DemoFieldErrors = Partial<Record<DemoFieldKey, string>>;

/** Coarse public status served by /api/demo/status (toPublicDemoStatus). */
export type DemoPublicStatus =
  | 'awaiting_confirmation'
  | 'queued'
  | 'calling'
  | 'in_call'
  | 'completed'
  | 'no_answer'
  | 'busy'
  | 'failed'
  | 'expired';

export interface DemoFormValues {
  company: string;
  contactName: string;
  email: string;
  phone: string;
  websiteUrl: string;
  prompt: string;
  consent: boolean;
  /** Honeypot — humans never see it, so it stays empty. */
  nickname: string;
}

export type DemoVerifyChannel = 'sms' | 'call';

/** What /api/demo/request answers: the polling token + where the code went. */
export interface DemoRequestResult {
  statusToken: string;
  channel: DemoVerifyChannel;
  /** Masked number for the code step (+49 170 ••••• 67). */
  phone: string;
}

export interface DemoResendResult {
  channel: DemoVerifyChannel;
  resendAfterSeconds: number;
  sendsLeft: number;
}

export interface DemoRequestPayload extends Omit<DemoFormValues, 'consent'> {
  renderToken: string;
  clientRequestId: string;
  consent: true;
}

/** Per-mount options read from the placeholder div's data attributes. */
export interface DemoMountOptions {
  /** data-accent (#rrggbb) — null = the zendori.ai brand gradient. */
  accent: string | null;
  title: string;
  privacyUrl: string | null;
}
