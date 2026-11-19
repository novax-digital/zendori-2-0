// Chat widget theme (channels.config.theme of a widget channel). ONE model for
// the three places that touch it:
//   - the embeddable widget (apps/web/src/widget, bundled standalone for
//     arbitrary customer websites — so this file must stay dependency-free:
//     no zod, no node APIs),
//   - the server (bootstrap route, channel settings),
//   - the designer with its live preview (settings → Kanäle → Chat → Design).
// Every field has a default and `normalizeWidgetTheme` accepts anything
// (missing keys, old three-field themes, hand-edited JSON) — the widget never
// trusts the stored shape. See docs/phase-2-widget.md ("Design").

export const WIDGET_SCHEMES = ['light', 'dark', 'auto'] as const;
export type WidgetScheme = (typeof WIDGET_SCHEMES)[number];

/**
 * 'inherit' = the font of the website the widget sits on. 'inter'/'sora' are
 * served by Zendori itself (public/widget-fonts, no third-party font host).
 * 'custom' names a font the website already loads.
 */
export const WIDGET_FONTS = ['system', 'inherit', 'inter', 'sora', 'serif', 'custom'] as const;
export type WidgetFont = (typeof WIDGET_FONTS)[number];

export const WIDGET_FONT_SIZES = ['sm', 'md', 'lg'] as const;
export type WidgetFontSize = (typeof WIDGET_FONT_SIZES)[number];

export const WIDGET_RADII = ['sharp', 'soft', 'round'] as const;
export type WidgetRadius = (typeof WIDGET_RADII)[number];

export const WIDGET_POSITIONS = ['right', 'left'] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

export const WIDGET_LAUNCHERS = ['icon', 'label'] as const;
export type WidgetLauncher = (typeof WIDGET_LAUNCHERS)[number];

export const WIDGET_LAUNCHER_ICONS = ['chat', 'message', 'question', 'spark', 'headset'] as const;
export type WidgetLauncherIcon = (typeof WIDGET_LAUNCHER_ICONS)[number];

export const WIDGET_AVATARS = ['none', 'icon', 'initials', 'image'] as const;
export type WidgetAvatar = (typeof WIDGET_AVATARS)[number];

export interface WidgetTheme {
  // --- texts ---
  /** Name in the header, e.g. the company or team name. */
  title: string;
  /** Second header line, e.g. "Wir antworten in wenigen Minuten". Empty = none. */
  subtitle: string;
  /** First bubble of every new chat. Empty = none. */
  greeting: string;
  /** Placeholder of the message field. */
  placeholder: string;
  /** Suggested first messages shown as chips under the greeting (at most 4). */
  quickReplies: string[];

  // --- colors ---
  /** Main color (#rrggbb): launcher, header, own messages, focus. */
  color: string;
  /** Launcher, header and own messages run from `color` to `color2`. */
  gradient: boolean;
  color2: string;
  /** Chat window light, dark or following the visitor's system setting. */
  scheme: WidgetScheme;

  // --- type ---
  font: WidgetFont;
  /** font-family name for font = 'custom' (a font the website loads itself). */
  customFont: string;
  fontSize: WidgetFontSize;

  // --- shape ---
  radius: WidgetRadius;
  position: WidgetPosition;
  /** Distance of the launcher from the side / bottom edge in px. */
  offsetX: number;
  offsetY: number;

  // --- launcher ---
  launcher: WidgetLauncher;
  /** Text of the 'label' launcher. */
  launcherLabel: string;
  launcherIcon: WidgetLauncherIcon;
  /** Small bubble next to the launcher that invites to chat. */
  teaser: boolean;
  teaserText: string;

  // --- header ---
  avatar: WidgetAvatar;
  /** https image for avatar = 'image' (logo or photo). */
  avatarUrl: string;

  /** "Bereitgestellt von Zendori" below the message field. */
  branding: boolean;
}

export const DEFAULT_WIDGET_THEME: WidgetTheme = {
  title: 'Support',
  subtitle: '',
  greeting: 'Hallo! Wie können wir helfen?',
  placeholder: 'Nachricht schreiben …',
  quickReplies: [],
  color: '#4f46e5',
  gradient: false,
  color2: '#06b6d4',
  scheme: 'light',
  font: 'system',
  customFont: '',
  fontSize: 'md',
  radius: 'soft',
  position: 'right',
  offsetX: 20,
  offsetY: 20,
  launcher: 'icon',
  launcherLabel: 'Chat mit uns',
  launcherIcon: 'chat',
  teaser: false,
  teaserText: 'Fragen? Wir helfen gern.',
  avatar: 'icon',
  avatarUrl: '',
  branding: false,
};

export const WIDGET_LIMITS = {
  title: 60,
  subtitle: 80,
  greeting: 300,
  placeholder: 60,
  quickReply: 40,
  quickReplies: 4,
  launcherLabel: 24,
  teaserText: 80,
  customFont: 60,
  avatarUrl: 500,
  offsetMin: 0,
  offsetMax: 80,
} as const;

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/** '#abc' / '#aabbcc' → '#aabbcc' (lower case); anything else → null. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (HEX6.test(trimmed)) return trimmed.toLowerCase();
  const short = HEX3.exec(trimmed);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return null;
}

function text(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
}

/** Like `text`, but an empty result falls back too (fields that must not be blank). */
function requiredText(value: unknown, fallback: string, max: number): string {
  return text(value, fallback, max) || fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function offset(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(WIDGET_LIMITS.offsetMax, Math.max(WIDGET_LIMITS.offsetMin, Math.round(n)));
}

/** A font-family NAME only: letters, digits, spaces, hyphens — nothing that could leave the CSS value. */
export function sanitizeFontName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, WIDGET_LIMITS.customFont);
}

/** https URLs only, without characters that could break out of an attribute or url(). */
export function sanitizeImageUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length > WIDGET_LIMITS.avatarUrl) return '';
  if (!/^https:\/\/[^\s"'<>()\\]+$/i.test(trimmed)) return '';
  return trimmed;
}

function quickReplies(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const reply = text(entry, '', WIDGET_LIMITS.quickReply);
    if (reply && !out.includes(reply)) out.push(reply);
    if (out.length >= WIDGET_LIMITS.quickReplies) break;
  }
  return out;
}

/**
 * Turns anything into a complete, safe theme. Unknown keys are dropped,
 * invalid values fall back to the defaults. Idempotent.
 */
export function normalizeWidgetTheme(raw: unknown): WidgetTheme {
  const input = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_WIDGET_THEME;
  const font = oneOf(input.font, WIDGET_FONTS, d.font);
  const customFont = sanitizeFontName(input.customFont);
  const avatar = oneOf(input.avatar, WIDGET_AVATARS, d.avatar);
  const avatarUrl = sanitizeImageUrl(input.avatarUrl);
  return {
    title: requiredText(input.title, d.title, WIDGET_LIMITS.title),
    subtitle: text(input.subtitle, d.subtitle, WIDGET_LIMITS.subtitle),
    greeting: text(input.greeting, d.greeting, WIDGET_LIMITS.greeting),
    placeholder: requiredText(input.placeholder, d.placeholder, WIDGET_LIMITS.placeholder),
    quickReplies: quickReplies(input.quickReplies),
    color: normalizeHexColor(input.color) ?? d.color,
    gradient: bool(input.gradient, d.gradient),
    color2: normalizeHexColor(input.color2) ?? d.color2,
    scheme: oneOf(input.scheme, WIDGET_SCHEMES, d.scheme),
    // a custom font without a name, or an image avatar without an image, is not a choice
    font: font === 'custom' && !customFont ? d.font : font,
    customFont,
    fontSize: oneOf(input.fontSize, WIDGET_FONT_SIZES, d.fontSize),
    radius: oneOf(input.radius, WIDGET_RADII, d.radius),
    position: oneOf(input.position, WIDGET_POSITIONS, d.position),
    offsetX: offset(input.offsetX, d.offsetX),
    offsetY: offset(input.offsetY, d.offsetY),
    launcher: oneOf(input.launcher, WIDGET_LAUNCHERS, d.launcher),
    launcherLabel: requiredText(input.launcherLabel, d.launcherLabel, WIDGET_LIMITS.launcherLabel),
    launcherIcon: oneOf(input.launcherIcon, WIDGET_LAUNCHER_ICONS, d.launcherIcon),
    teaser: bool(input.teaser, d.teaser),
    teaserText: requiredText(input.teaserText, d.teaserText, WIDGET_LIMITS.teaserText),
    avatar: avatar === 'image' && !avatarUrl ? d.avatar : avatar,
    avatarUrl,
    branding: bool(input.branding, d.branding),
  };
}

// --- derived values ---------------------------------------------------------------

/** WCAG relative luminance of a #rrggbb color (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const color = normalizeHexColor(hex) ?? '#000000';
  const channel = (offsetIndex: number): number => {
    const c = parseInt(color.slice(offsetIndex, offsetIndex + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of two colors (1 … 21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const ON_ACCENT_LIGHT = '#ffffff';
const ON_ACCENT_DARK = '#0f172a';

/**
 * Text color on the accent surface (launcher, header, own messages): white or
 * near-black, whichever reads better. With a gradient the text must work on
 * BOTH ends, so the weaker end decides.
 */
export function onAccentColor(theme: Pick<WidgetTheme, 'color' | 'gradient' | 'color2'>): string {
  const colors = theme.gradient ? [theme.color, theme.color2] : [theme.color];
  const worst = (textColor: string): number =>
    Math.min(...colors.map((color) => contrastRatio(textColor, color)));
  return worst(ON_ACCENT_LIGHT) >= worst(ON_ACCENT_DARK) ? ON_ACCENT_LIGHT : ON_ACCENT_DARK;
}

/** The accent surface as a CSS background value. */
export function accentBackground(theme: Pick<WidgetTheme, 'color' | 'gradient' | 'color2'>): string {
  return theme.gradient
    ? `linear-gradient(135deg, ${theme.color} 0%, ${theme.color2} 100%)`
    : theme.color;
}

const SYSTEM_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Font families served by Zendori (FontFace names + files under /widget-fonts). */
export const WIDGET_HOSTED_FONTS: Record<
  'inter' | 'sora',
  { family: string; files: { weight: number; file: string }[] }
> = {
  inter: {
    family: 'Zendori Inter',
    files: [
      { weight: 400, file: 'inter-400.woff2' },
      { weight: 500, file: 'inter-500.woff2' },
      { weight: 600, file: 'inter-600.woff2' },
    ],
  },
  sora: {
    family: 'Zendori Sora',
    files: [
      { weight: 400, file: 'sora-400.woff2' },
      { weight: 600, file: 'sora-600.woff2' },
    ],
  },
};

/** CSS font-family value for the theme. */
export function widgetFontStack(theme: Pick<WidgetTheme, 'font' | 'customFont'>): string {
  switch (theme.font) {
    case 'inherit':
      return 'inherit';
    case 'inter':
      return `'${WIDGET_HOSTED_FONTS.inter.family}', ${SYSTEM_STACK}`;
    case 'sora':
      return `'${WIDGET_HOSTED_FONTS.sora.family}', ${SYSTEM_STACK}`;
    case 'serif':
      return "Georgia, 'Iowan Old Style', 'Times New Roman', Times, serif";
    case 'custom': {
      const name = sanitizeFontName(theme.customFont);
      return name ? `'${name}', ${SYSTEM_STACK}` : SYSTEM_STACK;
    }
    default:
      return SYSTEM_STACK;
  }
}

/** One or two letters for the avatar = 'initials' ("Müller Haustechnik" → "MH"). */
export function widgetInitials(title: string): string {
  const words = title.trim().split(/[\s._-]+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const second = words.length > 1 ? (words[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase() || '?';
}

// --- presets ----------------------------------------------------------------------

export interface WidgetPreset {
  key: string;
  label: string;
  /** Only look, never texts — applying a preset keeps title, greeting and replies. */
  theme: Pick<
    WidgetTheme,
    'color' | 'gradient' | 'color2' | 'scheme' | 'font' | 'radius' | 'launcher' | 'avatar'
  >;
}

/** Ready-made looks of the designer. */
export const WIDGET_PRESETS: WidgetPreset[] = [
  {
    key: 'zendori',
    label: 'Zendori',
    theme: {
      color: '#00805a',
      gradient: true,
      color2: '#0070c4',
      scheme: 'light',
      font: 'inter',
      radius: 'round',
      launcher: 'icon',
      avatar: 'icon',
    },
  },
  {
    key: 'indigo',
    label: 'Indigo',
    theme: {
      color: '#4f46e5',
      gradient: true,
      color2: '#7c3aed',
      scheme: 'light',
      font: 'system',
      radius: 'soft',
      launcher: 'icon',
      avatar: 'icon',
    },
  },
  {
    key: 'midnight',
    label: 'Mitternacht',
    theme: {
      color: '#38bdf8',
      gradient: false,
      color2: '#818cf8',
      scheme: 'dark',
      font: 'inter',
      radius: 'soft',
      launcher: 'icon',
      avatar: 'initials',
    },
  },
  {
    key: 'coral',
    label: 'Koralle',
    theme: {
      color: '#f43f5e',
      gradient: true,
      color2: '#f97316',
      scheme: 'light',
      font: 'sora',
      radius: 'round',
      launcher: 'label',
      avatar: 'initials',
    },
  },
  {
    key: 'forest',
    label: 'Wald',
    theme: {
      color: '#166534',
      gradient: false,
      color2: '#65a30d',
      scheme: 'light',
      font: 'serif',
      radius: 'soft',
      launcher: 'icon',
      avatar: 'icon',
    },
  },
  {
    key: 'plain',
    label: 'Schlicht',
    theme: {
      color: '#0f172a',
      gradient: false,
      color2: '#334155',
      scheme: 'auto',
      font: 'inherit',
      radius: 'sharp',
      launcher: 'label',
      avatar: 'none',
    },
  },
];
