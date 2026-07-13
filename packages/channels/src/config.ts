import { z } from 'zod';

// channels.config shapes per channel type. Secrets inside configs are stored
// encrypted (core encryptSecret) — schemas here only see the ciphertext strings.

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
  /** Optional verified sender domain for outbound mail. */
  senderDomain: z.string().optional(),
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
  connectionState: z.enum(['active', 'needs_reconnect']).default('active'),
});

export const whatsappChannelConfigSchema = z.discriminatedUnion('provider', [
  whatsappMetaConfigSchema,
  whatsappTwilioConfigSchema,
]);

export type WhatsAppChannelConfig = z.infer<typeof whatsappChannelConfigSchema>;
export type WhatsAppTwilioConfig = z.infer<typeof whatsappTwilioConfigSchema>;
export type WhatsAppMetaConfig = z.infer<typeof whatsappMetaConfigSchema>;

export const voiceChannelConfigSchema = z.object({
  type: z.literal('voice'),
  /** Encrypted per-org voice API key ("v1:…"). */
  apiKeyEncrypted: z.string(),
  transferNumber: z.string().optional(),
});

export const channelConfigSchema = z.union([
  chatChannelConfigSchema,
  emailInboundConfigSchema,
  emailImapConfigSchema,
  whatsappChannelConfigSchema,
  voiceChannelConfigSchema,
]);

export type ChannelConfig = z.infer<typeof channelConfigSchema>;
