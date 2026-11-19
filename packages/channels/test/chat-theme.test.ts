import { describe, expect, it } from 'vitest';
import {
  accentBackground,
  contrastRatio,
  DEFAULT_WIDGET_THEME,
  normalizeHexColor,
  normalizeWidgetTheme,
  onAccentColor,
  sanitizeFontName,
  sanitizeImageUrl,
  WIDGET_PRESETS,
  widgetFontStack,
  widgetInitials,
} from '../src/chat/theme.js';

// Chat widget theme: one defensive model for widget, server and designer.

describe('normalizeWidgetTheme', () => {
  it('fills a missing or empty theme with the defaults', () => {
    expect(normalizeWidgetTheme(undefined)).toEqual(DEFAULT_WIDGET_THEME);
    expect(normalizeWidgetTheme(null)).toEqual(DEFAULT_WIDGET_THEME);
    expect(normalizeWidgetTheme('nonsense')).toEqual(DEFAULT_WIDGET_THEME);
  });

  it('keeps the three fields of an old theme and defaults the rest', () => {
    const theme = normalizeWidgetTheme({ color: '#0E9F9C', title: 'Strong Energy', greeting: 'Moin!' });
    expect(theme.color).toBe('#0e9f9c');
    expect(theme.title).toBe('Strong Energy');
    expect(theme.greeting).toBe('Moin!');
    expect(theme.scheme).toBe('light');
    expect(theme.font).toBe('system');
    expect(theme.quickReplies).toEqual([]);
  });

  it('is idempotent', () => {
    const once = normalizeWidgetTheme({
      title: '  Team  ',
      color: '#abc',
      gradient: true,
      color2: '#112233',
      quickReplies: ['Preise', 'Preise', ' Termin '],
      font: 'custom',
      customFont: 'Open Sans',
      offsetX: '32',
    });
    expect(normalizeWidgetTheme(once)).toEqual(once);
    expect(once.color).toBe('#aabbcc');
    expect(once.quickReplies).toEqual(['Preise', 'Termin']);
    expect(once.offsetX).toBe(32);
  });

  it('rejects invalid values instead of passing them on', () => {
    const theme = normalizeWidgetTheme({
      color: 'red; background:url(x)',
      scheme: 'neon',
      font: 'comic',
      radius: 'blob',
      position: 'top',
      offsetX: 9999,
      offsetY: -5,
      launcher: 42,
      avatar: 'image',
      avatarUrl: 'javascript:alert(1)',
      quickReplies: 'Preise',
      gradient: 'yes',
      title: '',
    });
    expect(theme.color).toBe(DEFAULT_WIDGET_THEME.color);
    expect(theme.scheme).toBe('light');
    expect(theme.font).toBe('system');
    expect(theme.radius).toBe('soft');
    expect(theme.position).toBe('right');
    expect(theme.offsetX).toBe(80);
    expect(theme.offsetY).toBe(0);
    expect(theme.launcher).toBe('icon');
    // an image avatar without a usable image falls back
    expect(theme.avatar).toBe(DEFAULT_WIDGET_THEME.avatar);
    expect(theme.avatarUrl).toBe('');
    expect(theme.quickReplies).toEqual([]);
    expect(theme.gradient).toBe(false);
    expect(theme.title).toBe(DEFAULT_WIDGET_THEME.title);
  });

  it('bounds texts and the number of quick replies', () => {
    const theme = normalizeWidgetTheme({
      title: 'x'.repeat(200),
      greeting: 'g'.repeat(900),
      quickReplies: ['a', 'b', 'c', 'd', 'e', 'f'].map((s) => s.repeat(60)),
    });
    expect(theme.title.length).toBe(60);
    expect(theme.greeting.length).toBe(300);
    expect(theme.quickReplies).toHaveLength(4);
    expect(theme.quickReplies[0]?.length).toBe(40);
  });

  it('allows an empty greeting and subtitle (no bubble, no second line)', () => {
    const theme = normalizeWidgetTheme({ greeting: '', subtitle: '   ' });
    expect(theme.greeting).toBe('');
    expect(theme.subtitle).toBe('');
  });

  it('drops a custom font without a name', () => {
    expect(normalizeWidgetTheme({ font: 'custom', customFont: '";}' }).font).toBe('system');
  });
});

describe('sanitizers', () => {
  it('normalizes hex colors', () => {
    expect(normalizeHexColor('#FFF')).toBe('#ffffff');
    expect(normalizeHexColor(' #12AbEf ')).toBe('#12abef');
    expect(normalizeHexColor('#12345')).toBeNull();
    expect(normalizeHexColor('rgb(0,0,0)')).toBeNull();
    expect(normalizeHexColor(123)).toBeNull();
  });

  it('keeps only a font NAME', () => {
    expect(sanitizeFontName("Open Sans'; color:red")).toBe('Open Sans colorred');
    expect(sanitizeFontName('  Söhne   Breit ')).toBe('Söhne Breit');
    expect(sanitizeFontName(null)).toBe('');
  });

  it('accepts only clean https image URLs', () => {
    expect(sanitizeImageUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png');
    expect(sanitizeImageUrl('http://example.com/logo.png')).toBe('');
    expect(sanitizeImageUrl('https://example.com/a b.png')).toBe('');
    expect(sanitizeImageUrl('https://example.com/x");background:url(evil')).toBe('');
    expect(sanitizeImageUrl('data:image/png;base64,AAAA')).toBe('');
  });
});

describe('derived values', () => {
  it('picks readable text on the accent color', () => {
    expect(onAccentColor({ color: '#4f46e5', gradient: false, color2: '#ffffff' })).toBe('#ffffff');
    expect(onAccentColor({ color: '#fde047', gradient: false, color2: '#000000' })).toBe('#0f172a');
    // gradient: the text has to work on both ends
    const mixed = onAccentColor({ color: '#fde047', gradient: true, color2: '#facc15' });
    expect(mixed).toBe('#0f172a');
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 0);
  });

  it('builds the accent background', () => {
    expect(accentBackground({ color: '#111111', gradient: false, color2: '#222222' })).toBe('#111111');
    expect(accentBackground({ color: '#111111', gradient: true, color2: '#222222' })).toBe(
      'linear-gradient(135deg, #111111 0%, #222222 100%)'
    );
  });

  it('maps fonts to CSS stacks', () => {
    expect(widgetFontStack({ font: 'inherit', customFont: '' })).toBe('inherit');
    expect(widgetFontStack({ font: 'inter', customFont: '' })).toContain("'Zendori Inter'");
    expect(widgetFontStack({ font: 'sora', customFont: '' })).toContain("'Zendori Sora'");
    expect(widgetFontStack({ font: 'serif', customFont: '' })).toContain('Georgia');
    expect(widgetFontStack({ font: 'custom', customFont: 'Open Sans' })).toMatch(/^'Open Sans', /);
    expect(widgetFontStack({ font: 'system', customFont: 'x' })).toContain('-apple-system');
  });

  it('derives initials', () => {
    expect(widgetInitials('Müller Haustechnik GmbH')).toBe('MH');
    expect(widgetInitials('support')).toBe('S');
    expect(widgetInitials('  ')).toBe('?');
  });
});

describe('presets', () => {
  it('are valid themes with readable accent text', () => {
    const keys = new Set<string>();
    for (const preset of WIDGET_PRESETS) {
      expect(keys.has(preset.key)).toBe(false);
      keys.add(preset.key);
      const theme = normalizeWidgetTheme({ ...DEFAULT_WIDGET_THEME, ...preset.theme });
      expect(theme).toMatchObject(preset.theme);
      const textColor = onAccentColor(theme);
      const ends = theme.gradient ? [theme.color, theme.color2] : [theme.color];
      for (const end of ends) expect(contrastRatio(textColor, end)).toBeGreaterThanOrEqual(3);
    }
  });
});
