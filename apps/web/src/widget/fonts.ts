import { WIDGET_HOSTED_FONTS, type WidgetTheme } from '@zendori/channels/chat-theme';

/**
 * Loads the theme font when it is one Zendori hosts itself ("Inter", "Sora").
 * The files come from {apiBase}/widget-fonts — no third-party font host, so
 * the visitor's IP only ever reaches the Zendori app (the same origin the
 * widget talks to anyway). Registered through the FontFace API: @font-face
 * rules inside a shadow root are ignored by browsers, document.fonts is not.
 * Every other font choice (system, website font, serif, custom name) needs no
 * loading. Failures are silent — the stack falls back to the system font.
 */

const requested = new Set<string>();

export function loadWidgetFont(theme: Pick<WidgetTheme, 'font'>, apiBase: string): void {
  if (theme.font !== 'inter' && theme.font !== 'sora') return;
  if (typeof FontFace === 'undefined' || !document.fonts) return;
  const spec = WIDGET_HOSTED_FONTS[theme.font];
  for (const { weight, file } of spec.files) {
    const key = `${spec.family}:${weight}`;
    if (requested.has(key)) continue;
    requested.add(key);
    try {
      const face = new FontFace(spec.family, `url(${apiBase}/widget-fonts/${file}) format('woff2')`, {
        weight: String(weight),
        style: 'normal',
        display: 'swap',
      });
      document.fonts.add(face);
      void face.load().catch(() => undefined);
    } catch {
      // invalid descriptor in an old browser — keep the fallback stack
    }
  }
}
