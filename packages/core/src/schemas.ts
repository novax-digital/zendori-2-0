import { z } from 'zod';

// --- domain enums ------------------------------------------------------------

export const orgRoleSchema = z.enum(['owner', 'agent']);
export type OrgRole = z.infer<typeof orgRoleSchema>;

export const channelTypeSchema = z.enum(['chat', 'email', 'whatsapp', 'voice']);
export type ChannelType = z.infer<typeof channelTypeSchema>;

export const conversationStatusSchema = z.enum(['open', 'pending', 'resolved']);
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;

export const conversationModeSchema = z.enum(['bot', 'human']);
export type ConversationMode = z.infer<typeof conversationModeSchema>;

export const conversationPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type ConversationPriority = z.infer<typeof conversationPrioritySchema>;

export const messageDirectionSchema = z.enum(['in', 'out']);
export type MessageDirection = z.infer<typeof messageDirectionSchema>;

export const senderTypeSchema = z.enum(['contact', 'agent', 'bot', 'system']);
export type SenderType = z.infer<typeof senderTypeSchema>;

export const contentTypeSchema = z.enum(['text', 'html', 'audio', 'image', 'file']);
export type ContentType = z.infer<typeof contentTypeSchema>;

export const processingStateSchema = z.enum(['pending', 'done', 'skipped']);
export type ProcessingState = z.infer<typeof processingStateSchema>;

export const handoffReasonSchema = z.enum([
  'low_confidence',
  'user_request',
  'keyword',
  'manual',
  'intake',
]);
export type HandoffReason = z.infer<typeof handoffReasonSchema>;

/**
 * Agent behavior mode (0011): draft_only = suggestions only, autopilot =
 * auto-send above the confidence threshold, intake_only = no RAG answer — just
 * ticketise the request and hand off ("reine Annahme").
 */
export const agentModeSchema = z.enum(['draft_only', 'autopilot', 'intake_only']);
export type AgentMode = z.infer<typeof agentModeSchema>;

/**
 * Agent kind (0015): a voice agent serves ONLY voice channels, a text agent
 * everything else. Voice agents allow only intake_only|autopilot modes.
 */
export const agentKindSchema = z.enum(['text', 'voice']);
export type AgentKind = z.infer<typeof agentKindSchema>;

/**
 * Channel KIND for quotas (0017) — the UI notion, finer than `type`: email
 * splits into 'form' (contact-form intake) and 'email' (forwarded mailbox),
 * chat splits into 'chat' (widget) and 'test'.
 */
export const channelKindSchema = z.enum(['form', 'email', 'whatsapp', 'voice', 'chat', 'test']);
export type ChannelKind = z.infer<typeof channelKindSchema>;

/** Phone number inventory/request lifecycle (0016). */
export const phoneNumberStatusSchema = z.enum(['requested', 'provisioning', 'active', 'released']);
export type PhoneNumberStatus = z.infer<typeof phoneNumberStatusSchema>;

export const phoneNumberTypeSchema = z.enum(['local', 'mobile', 'national']);
export type PhoneNumberType = z.infer<typeof phoneNumberTypeSchema>;

export const kbSourceTypeSchema = z.enum(['url', 'file', 'text']);
export type KbSourceType = z.infer<typeof kbSourceTypeSchema>;

export const kbSourceStatusSchema = z.enum(['pending', 'indexed', 'error']);
export type KbSourceStatus = z.infer<typeof kbSourceStatusSchema>;

export const integrationTypeSchema = z.enum(['hubspot']);
export type IntegrationType = z.infer<typeof integrationTypeSchema>;

// --- integration sync rules ----------------------------------------------------

export const syncRulesSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({ mode: z.literal('channels'), channel_ids: z.array(z.uuid()) }),
  z.object({ mode: z.literal('manual') }),
]);
export type SyncRules = z.infer<typeof syncRulesSchema>;

// --- entities (DB row shapes at system boundaries) ------------------------------

export const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  slug: z.string().min(1),
  created_at: z.string(),
});
export type Organization = z.infer<typeof organizationSchema>;

export const orgMemberSchema = z.object({
  org_id: z.uuid(),
  user_id: z.uuid(),
  role: orgRoleSchema,
  created_at: z.string(),
});
export type OrgMember = z.infer<typeof orgMemberSchema>;

export const channelSchema = z.object({
  id: z.uuid(),
  org_id: z.uuid(),
  type: channelTypeSchema,
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()),
  /** Assigned AI agent (0011); null = no agent = no drafts, no auto-sends. */
  agent_id: z.uuid().nullable(),
  is_active: z.boolean(),
  created_at: z.string(),
});
export type Channel = z.infer<typeof channelSchema>;

/** AI agent entity (0011): identity/prompt + behavior, assigned to channels. */
export const agentSchema = z.object({
  id: z.uuid(),
  org_id: z.uuid(),
  name: z.string().min(1),
  /** Persona / system prompt ("Identität"); null = neutral default persona. */
  identity: z.string().nullable(),
  /** 0015: voice agents serve only voice channels, text agents everything else. */
  kind: agentKindSchema,
  mode: agentModeSchema,
  confidence_threshold: z.number().min(0).max(1),
  is_active: z.boolean(),
  created_at: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

export const contactSchema = z.object({
  id: z.uuid(),
  org_id: z.uuid(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  wa_id: z.string().nullable(),
  external_ids: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type Contact = z.infer<typeof contactSchema>;

export const conversationSchema = z.object({
  id: z.uuid(),
  org_id: z.uuid(),
  channel_id: z.uuid(),
  contact_id: z.uuid().nullable(),
  subject: z.string().nullable(),
  status: conversationStatusSchema,
  mode: conversationModeSchema,
  assignee_id: z.uuid().nullable(),
  priority: conversationPrioritySchema,
  last_message_at: z.string().nullable(),
  external_refs: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const messageSchema = z.object({
  id: z.uuid(),
  org_id: z.uuid(),
  conversation_id: z.uuid(),
  channel_id: z.uuid(),
  direction: messageDirectionSchema,
  sender_type: senderTypeSchema,
  content: z.string(),
  content_type: contentTypeSchema,
  external_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  processing_state: processingStateSchema.nullable(),
  created_at: z.string(),
});
export type Message = z.infer<typeof messageSchema>;
