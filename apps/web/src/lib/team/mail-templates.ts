// Branded transactional e-mail template (modeled 1:1 on the Versendio
// renderBrandedEmail pattern the owner likes, re-skinned for Zendori): a 560px
// white card on a light page, plain header with a brand mark + text wordmark
// (no images — SVG logos are blocked by most clients, and a pure-HTML mark
// keeps the mail branded even with images off), bulletproof pill CTA in brand
// teal, and the DDG imprint footer. Table layout + inline CSS throughout for
// client compatibility; always returns a plain-text fallback.
//
// Pure module (no 'server-only', no node imports) so templates are unit- and
// preview-testable outside Next.

const BRAND = '#0895a1'; // brand-600 — CTA (better contrast than brand-500)
const BRAND_LIGHT = '#0bb8ba'; // brand-500 — header mark
const INK = '#1e293b';
const MUTED = '#64748b';
const PAGE_BG = '#f8fafc';
const CARD_BORDER = '#e2e8f0';
const DIVIDER = '#e8f6f6';
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface ZendoriMailInput {
  /** Hidden inbox-preview line (shown next to the subject in most clients). */
  preheader: string;
  /** Greeting name (escaped); omit for "Guten Tag,". */
  recipientName?: string | null;
  /** Body paragraphs — developer-authored HTML (escape user input yourself). */
  paragraphs: string[];
  cta?: { label: string; url: string };
  /** Small muted line under the CTA (e.g. link validity note). */
  finePrint?: string;
  appUrl: string;
}

export function renderZendoriEmail(input: ZendoriMailInput): { html: string; text: string } {
  const appUrl = input.appUrl.replace(/\/+$/, '');
  const year = new Date().getFullYear();
  const greeting = input.recipientName
    ? `Guten Tag ${escapeHtml(input.recipientName)},`
    : 'Guten Tag,';

  const paragraphsHtml = input.paragraphs
    .map(
      (p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${INK}">${p}</p>`
    )
    .join('\n          ');

  const ctaHtml = input.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0 4px"><tr><td style="border-radius:9999px;background:${BRAND}">
            <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(input.cta.label)}</a>
          </td></tr></table>
          ${
            input.finePrint
              ? `<p style="margin:10px 0 0;font-size:12px;line-height:1.5;color:${MUTED}">${escapeHtml(input.finePrint)}</p>`
              : ''
          }`
    : '';

  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:${PAGE_BG};font-family:${FONT}">
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${escapeHtml(input.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:32px 12px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:14px;border:1px solid ${CARD_BORDER};overflow:hidden">

        <tr><td style="padding:20px 28px;border-bottom:1px solid ${DIVIDER}">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td width="26" height="26" align="center" style="width:26px;height:26px;border-radius:7px;background:${BRAND_LIGHT};color:#ffffff;font-family:${FONT};font-size:15px;font-weight:700;line-height:26px">Z</td>
            <td style="padding-left:9px;font-family:${FONT};font-size:18px;font-weight:600;color:${INK}">Zendori</td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:28px">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${INK}">${greeting}</p>
          ${paragraphsHtml}
          ${ctaHtml}
          <p style="margin:20px 0 0;font-size:15px;line-height:1.6;color:${INK}">Mit freundlichen Grüßen<br>Ihr Zendori-Team</p>
        </td></tr>

        <tr><td style="padding:18px 28px;border-top:1px solid ${DIVIDER}">
          <p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED}">
            Diese E-Mail wurde automatisch von <a href="${appUrl}" style="color:${BRAND};text-decoration:none">Zendori</a> versendet.
            <br>© ${year} Zendori
          </p>
          <p style="margin:10px 0 0;font-size:11px;line-height:1.6;color:${MUTED}">
            Angaben gemäß § 5 DDG: Novax Digital GmbH · Schierholzstr. 27 · 30655 Hannover · Deutschland<br>
            Vertreten durch die Geschäftsführer: Philipp Polley, Christoph Pfad<br>
            Telefon: 0511 9012188-5 · E-Mail: <a href="mailto:info@zendori.ai" style="color:${MUTED};text-decoration:underline">info@zendori.ai</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const textParagraphs = input.paragraphs.map(stripHtml);
  const text = [
    greetingText(input.recipientName),
    '',
    ...textParagraphs.flatMap((p) => [p, '']),
    ...(input.cta ? [`${input.cta.label}: ${input.cta.url}`, ''] : []),
    ...(input.finePrint ? [input.finePrint, ''] : []),
    'Mit freundlichen Grüßen',
    'Ihr Zendori-Team',
    '',
    `— © ${year} Zendori · Novax Digital GmbH · Schierholzstr. 27 · 30655 Hannover`,
  ].join('\n');

  return { html, text };
}

function greetingText(name?: string | null): string {
  return name ? `Guten Tag ${name},` : 'Guten Tag,';
}

/** <a href="u">t</a> → "t (u)", <br> → newline, strip remaining tags. */
function stripHtml(html: string): string {
  return html
    .replace(/<a\s+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '$2 ($1)')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}
