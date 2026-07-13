// Thin re-export so apps/web keeps a stable import path for the WhatsApp send
// entry point (mirrors lib/email/dispatch.ts). The implementation lives in
// @zendori/channels so apps/web and apps/worker share one send path (§4).
export { deliverOutboundWhatsApp } from '@zendori/channels';
export type { WhatsAppDeliverResult } from '@zendori/channels';
