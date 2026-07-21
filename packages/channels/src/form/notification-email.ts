// Styled forwarding e-mail for form submissions (Phase 10). Table-based HTML
// with inline CSS (e-mail-client compatible) + a plain-text part. Every field
// value is HTML-escaped — form values are attacker-controlled and must never
// inject markup into the recipient's mail client.

export interface NotificationField {
  label: string;
  value: string;
}

export interface FormNotificationInput {
  orgName: string;
  formName: string;
  fields: NotificationField[];
  /** Consent text the submitter accepted (shown as proof line), if any. */
  consentText?: string | null;
  /** Absolute inbox deep link to the conversation. */
  conversationUrl?: string | null;
  /** Accent color from the form design (validated #rrggbb upstream). */
  color?: string;
  submittedAt: Date;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Multi-line values keep their line breaks in the HTML table. */
function htmlValue(value: string): string {
  return escapeHtml(value).replaceAll('\n', '<br />');
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;

export function renderFormNotificationEmail(input: FormNotificationInput): {
  subject: string;
  html: string;
  text: string;
} {
  const color = input.color && SAFE_COLOR.test(input.color) ? input.color : '#0bb8ba';
  const subject = `Neue Formular-Einsendung: ${input.formName}`;
  const dateText = input.submittedAt.toLocaleString('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Berlin',
  });

  const rows = input.fields
    .map(
      (field) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;vertical-align:top;white-space:nowrap;">${escapeHtml(field.label)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#0f172a;font-size:14px;">${htmlValue(field.value)}</td>
        </tr>`
    )
    .join('');

  const consentBlock = input.consentText
    ? `<p style="margin:16px 0 0;color:#94a3b8;font-size:12px;">Zustimmung erteilt: „${escapeHtml(input.consentText)}"</p>`
    : '';

  const linkBlock = input.conversationUrl
    ? `<p style="margin:20px 0 0;"><a href="${escapeHtml(input.conversationUrl)}" style="color:${color};font-size:14px;">In Zendori öffnen →</a></p>`
    : '';

  const html = `<!doctype html>
<html lang="de">
  <body style="margin:0;padding:24px;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr>
        <td style="background:${color};padding:18px 24px;">
          <span style="color:#ffffff;font-size:16px;font-weight:bold;">${escapeHtml(input.orgName)}</span>
          <span style="color:rgba(255,255,255,0.85);font-size:13px;display:block;margin-top:2px;">Neue Einsendung · ${escapeHtml(input.formName)} · ${escapeHtml(dateText)}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 24px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
          </table>
          ${consentBlock}
          ${linkBlock}
          <p style="margin:24px 0 0;color:#94a3b8;font-size:11px;">Über Zendori eingegangen. Antworten an diese E-Mail gehen direkt an die einsendende Person.</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    `Neue Einsendung: ${input.formName} (${input.orgName})`,
    `Eingegangen: ${dateText}`,
    '',
    ...input.fields.map((field) => `${field.label}: ${field.value}`),
    ...(input.consentText ? ['', `Zustimmung erteilt: "${input.consentText}"`] : []),
    ...(input.conversationUrl ? ['', `In Zendori öffnen: ${input.conversationUrl}`] : []),
  ].join('\n');

  return { subject, html, text };
}
