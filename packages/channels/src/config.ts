import { z } from 'zod';

// channels.config shapes per channel type. Secrets inside configs are stored
// encrypted (core encryptSecret) — schemas here only see the ciphertext strings.

// NOTE: the widget channels created by apps/web actually use a different,
// snake_case config shape ({ widget: true, public_token, theme,
// conversation_split_hours }) parsed by apps/web/src/lib/widget/session.ts —
// that schema is the source of truth for widget lookups. This one predates it
// and is kept only for the config union; align them before reusing it.
export const chatChannelConfigSchema = z.object({
  type: z.literal('chat'),
  publicToken: z.string().min(1),
  theme: z
    .object({
      color: z.string().optional(),
      greeting: z.string().optional(),
    })
    .optional(),
});

export const emailInboundConfigSchema = z.object({
  type: z.literal('email'),
  mode: z.literal('inbound'),
  /** Generated, non-guessable intake address, e.g. strongenergy-kf-x7k2m9@in.zendori.de */
  address: z.email(),
  /**
   * What feeds this intake address (Phase 8). 'form' = a website contact form
   * posts here; the real sender is extracted from the form block. 'forwarded_email'
   * = a mailbox forwards here; the real sender comes from the forwarding header.
   * Absent on legacy rows ⇒ treated as 'form'.
   */
  purpose: z.enum(['form', 'forwarded_email']).default('form'),
  /** Optional verified sender domain for outbound mail. */
  senderDomain: z.string().optional(),
  /**
   * Marks a form-builder channel (Phase 10): the channel was created by the
   * builder and carries exactly one `forms` row (definition, embed token,
   * notification recipients). Absent on classic intake channels.
   */
  builderForm: z.boolean().optional(),
});

export const emailImapConfigSchema = z.object({
  type: z.literal('email'),
  mode: z.literal('imap'),
  imapHost: z.string(),
  imapPort: z.number().int(),
  smtpHost: z.string(),
  smtpPort: z.number().int(),
  username: z.string(),
  /** Encrypted with core encryptSecret ("v1:…"). */
  passwordEncrypted: z.string(),
});

/**
 * Provider-independent descriptor of the approved template used outside the 24h
 * service window. Meta needs name+languageCode; Twilio needs the approved
 * ContentSid. Both are pre-approved in the provider console (Phase 7).
 */
export const whatsappTemplateConfigSchema = z.object({
  /** Meta: approved template name. Twilio: a logical label. */
  name: z.string().min(1),
  /** Meta only: exact approved locale, e.g. "de" | "de_DE". */
  languageCode: z.string().optional(),
  /** Twilio only: approved Content SID (HX…) backing this template. */
  twilioContentSid: z.string().optional(),
});

/** Meta WhatsApp Cloud API — customer owns the number/WABA (Phase 7b). */
export const whatsappMetaConfigSchema = z.object({
  type: z.literal('whatsapp'),
  provider: z.literal('meta'),
  /** ROUTING KEY (plaintext, queried in SQL). */
  phoneNumberId: z.string().min(1),
  /** WhatsApp Business Account id (plaintext). */
  wabaId: z.string().min(1),
  /** Cosmetic display number (plaintext). */
  displayPhoneNumber: z.string().optional(),
  /** Encrypted per-WABA Bearer token ("v1:…"). */
  accessTokenEncrypted: z.string(),
  /** Model A only: encrypted per-app secret ("v1:…"); absent ⇒ verify with env WHATSAPP_APP_SECRET (Model B). */
  appSecretEncrypted: z.string().optional(),
  graphVersion: z.string().default('v25.0'),
  fallbackServiceTemplate: whatsappTemplateConfigSchema.optional(),
  /** Hours of inactivity after which a new inbound message starts a NEW
   *  conversation (ticket separation). Absent = never split. `pending`
   *  conversations are never split regardless (see conversation-split.ts). */
  conversationSplitHours: z.number().int().min(1).max(8760).optional(),
  connectionState: z.enum(['active', 'needs_reconnect']).default('active'),
});

/** Twilio WhatsApp — operator (Novax) owns the sender number (Phase 7a). */
export const whatsappTwilioConfigSchema = z.object({
  type: z.literal('whatsapp'),
  provider: z.literal('twilio'),
  /** "+E164" ROUTING KEY (plaintext, queried in SQL). */
  sender: z.string().min(1),
  /** AC… (sub)account SID (plaintext). */
  accountSid: z.string().min(1),
  /** MG… messaging service SID (plaintext, optional). */
  messagingServiceSid: z.string().optional(),
  /** Encrypted Auth Token ("v1:…") — used BOTH to verify X-Twilio-Signature AND to send. */
  authTokenEncrypted: z.string(),
  fallbackServiceTemplate: whatsappTemplateConfigSchema.optional(),
  /** Hours of inactivity after which a new inbound message starts a NEW
   *  conversation (ticket separation). Absent = never split. `pending`
   *  conversations are never split regardless (see conversation-split.ts). */
  conversationSplitHours: z.number().int().min(1).max(8760).optional(),
  connectionState: z.enum(['active', 'needs_reconnect']).default('active'),
});

export const whatsappChannelConfigSchema = z.discriminatedUnion('provider', [
  whatsappMetaConfigSchema,
  whatsappTwilioConfigSchema,
]);

export type WhatsAppChannelConfig = z.infer<typeof whatsappChannelConfigSchema>;
export type WhatsAppTwilioConfig = z.infer<typeof whatsappTwilioConfigSchema>;
export type WhatsAppMetaConfig = z.infer<typeof whatsappMetaConfigSchema>;

/** Voice via xAI Grok Voice + Twilio SIP (Phase 9). One Twilio number per org. */
export const voiceChannelConfigSchema = z.object({
  type: z.literal('voice'),
  provider: z.literal('xai'),
  /** ROUTING KEY (plaintext, queried in SQL): E.164 of the Twilio number registered at xAI. */
  phoneNumber: z.string().min(1),
  /** xAI phone-number resource id (POST /v2/phone-numbers) — for teardown/update. */
  xaiPhoneNumberId: z.string().optional(),
  /** Twilio provisioning bookkeeping. */
  twilioPhoneNumberSid: z.string().optional(),
  twilioTrunkSid: z.string().optional(),
  /** One-time Standard-Webhooks signing secret from xAI registration, encrypted ("v1:…"). */
  dispatchSigningSecretEncrypted: z.string(),
  // Behavioral fields (agentMode, instructions) moved to the assigned agents
  // row (0011) — the channel keeps only voice-technical parameters. Legacy keys
  // still present in old config jsonb are stripped on parse.
  /** Exact opening line the bot must speak (channel-specific, stays here).
   *  Bounded so a jsonb written past the app-layer cap fails the worker's
   *  re-parse instead of injecting an oversized prompt block. Spoken verbatim
   *  via force_message; when absent the model generates the greeting itself. */
  greeting: z.string().max(500).optional(),
  /** Whether the caller may barge into the configured greeting (default: no —
   *  the opening plays out fully). Only meaningful when `greeting` is set. */
  greetingInterruptible: z.boolean().default(false),
  /** eve|ara|rex|sal|leo or a custom voice id. */
  voice: z.string().default('eve'),
  /** BCP-47 ASR language hint — doubles as the conversation language (the
   *  session prompt instructs the model to converse in this language). */
  languageHint: z.string().default('de'),
  /** Brand/product names improving German ASR (xAI: max 100 × 50 chars). */
  keyterms: z.array(z.string().max(50)).max(100).default([]),
  speechSpeed: z.number().min(0.7).max(1.5).default(1.0),
  /** tel:+E164 live-transfer target; absent ⇒ callback-ticket handoff only. */
  transferNumber: z.string().optional(),
  maxCallSeconds: z.number().int().positive().default(900),
  /**
   * Call recording (owner opt-in, default off). When on, the session speaks a
   * mandatory recording notice (§201 StGB: both-party consent) before the
   * greeting, starts a dual-channel recording at Twilio, and the post-call job
   * moves the audio to Supabase Storage (EU) and deletes it at Twilio.
   */
  recordingEnabled: z.boolean().default(false),
  connectionState: z.enum(['active', 'needs_reconnect']).default('active'),
});

export type VoiceChannelConfig = z.infer<typeof voiceChannelConfigSchema>;

export const channelConfigSchema = z.union([
  chatChannelConfigSchema,
  emailInboundConfigSchema,
  emailImapConfigSchema,
  whatsappChannelConfigSchema,
  voiceChannelConfigSchema,
]);

export type ChannelConfig = z.infer<typeof channelConfigSchema>;
