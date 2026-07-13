// Outbound e-mail delivery moved to @zendori/channels in Phase 5 so the worker
// (bot auto-send / auto-ack) can reuse it. This thin re-export keeps the Phase-3
// import path (`@/lib/email/dispatch`) working for the inbox server actions.
export { deliverOutboundEmail } from '@zendori/channels';
