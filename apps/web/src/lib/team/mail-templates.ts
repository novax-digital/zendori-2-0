// The branded Zendori mail layout moved to @zendori/channels (email/brand-mail.ts)
// so the worker renders member notifications with the same template. This module
// keeps the import path of the existing callers (invite, password reset).
export {
  escapeHtml,
  renderZendoriEmail,
  type ZendoriMailDetail,
  type ZendoriMailInput,
} from '@zendori/channels';
