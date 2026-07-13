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

export const whatsappChannelConfigSchema = z.object({
  type: z.literal('whatsapp'),
  phoneNumberId: z.string(),
  /** Encrypted with core encryptSecret ("v1:…"). */
  accessTokenEncrypted: z.string(),
});

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
