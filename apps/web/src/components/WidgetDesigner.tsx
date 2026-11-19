'use client';

// Designer of the chat widget (Kanäle → Chat → Design): every look option of
// the theme (packages/channels chat/theme.ts) on the left, the REAL widget on
// the right — the preview runs the same code that ships to customer websites
// (widget/ui.ts in preview mode), so what you see is what visitors get.
// Rendered inside the page's <form>: all controls carry the field names the
// updateWidgetTheme action reads.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeWidgetTheme,
  onAccentColor,
  WIDGET_LIMITS,
  WIDGET_PRESETS,
  type WidgetLauncherIcon,
  type WidgetTheme,
} from '@zendori/channels/chat-theme';
import { loadWidgetFont } from '@/widget/fonts';
import { createWidgetUi } from '@/widget/ui';
import { Field, SettingRow } from '@/components/ui/Field';
import { Section } from '@/components/ui/Layout';
import Segmented from '@/components/ui/Segmented';

type PreviewView = 'start' | 'chat' | 'closed';

const FONT_OPTIONS: { value: WidgetTheme['font']; label: string }[] = [
  { value: 'system', label: 'Systemschrift' },
  { value: 'inherit', label: 'Schrift deiner Website' },
  { value: 'inter', label: 'Inter' },
  { value: 'sora', label: 'Sora' },
  { value: 'serif', label: 'Serifenschrift (Georgia)' },
  { value: 'custom', label: 'Eigene Schrift …' },
];

const ICON_LABELS: Record<WidgetLauncherIcon, string> = {
  chat: 'Sprechblase',
  message: 'Zwei Sprechblasen',
  question: 'Fragezeichen',
  spark: 'Funkeln',
  headset: 'Kopfhörer',
};

/** Same path data as the widget's launcher icons (widget/ui.ts). */
const ICON_PATHS: Record<WidgetLauncherIcon, string[]> = {
  chat: ['M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
  message: [
    'M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z',
    'M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1',
  ],
  question: [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
    'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3',
    'M12 17h.01',
  ],
  spark: [
    'M12 3l1.9 5.6 5.6 1.9-5.6 1.9L12 18l-1.9-5.6-5.6-1.9 5.6-1.9L12 3z',
    'M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z',
  ],
  headset: [
    'M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3',
  ],
};

function LauncherIcon({ name }: { name: WidgetLauncherIcon }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Color well + hex field, both editing the same value. */
function ColorField({
  id,
  name,
  value,
  onChange,
}: {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  // presets and the color well change the value from outside the text field
  useEffect(() => setText(value), [value]);
  return (
    <span className="wd-color">
      <input
        id={id}
        name={name}
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        type="text"
        className="mono"
        aria-label="Farbe als Hex-Wert"
        value={text}
        maxLength={7}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value.trim();
          setText(next);
          if (/^#[0-9a-fA-F]{6}$/.test(next)) onChange(next.toLowerCase());
        }}
        onBlur={() => setText(value)}
      />
    </span>
  );
}

function replySlots(replies: string[]): string[] {
  return [...replies, '', '', '', ''].slice(0, WIDGET_LIMITS.quickReplies);
}

export default function WidgetDesigner({ initial }: { initial: WidgetTheme }) {
  const [theme, setTheme] = useState<WidgetTheme>(initial);
  // four fixed slots while editing; empty ones are dropped on save and in the preview
  const [replies, setReplies] = useState<string[]>(() => replySlots(initial.quickReplies));
  const [view, setView] = useState<PreviewView>('start');
  const stageRef = useRef<HTMLDivElement>(null);

  const set = <K extends keyof WidgetTheme>(key: K, value: WidgetTheme[K]): void =>
    setTheme((current) => ({ ...current, [key]: value }));

  /** Exactly what a save would store — the preview never shows more than that. */
  const previewTheme = useMemo(
    () => normalizeWidgetTheme({ ...theme, quickReplies: replies }),
    [theme, replies]
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.textContent = '';
    const host = document.createElement('div');
    stage.appendChild(host);
    const shadow = host.attachShadow({ mode: 'closed' });
    loadWidgetFont(previewTheme, window.location.origin);
    const ui = createWidgetUi(
      shadow,
      previewTheme,
      {
        // the preview is playable: typed messages appear, nothing is sent
        onSend: (content) => ui.addContactMessage(content).setState('sent'),
        onContactSave: async () => null,
        onContactSkip: () => undefined,
      },
      { preview: true }
    );
    if (view === 'closed') {
      ui.showTeaser();
    } else {
      ui.open();
      if (view === 'chat') {
        ui.addContactMessage('Habt ihr am Samstag geöffnet?').setState('sent');
        ui.addAgentMessage('Ja, samstags sind wir von 9 bis 14 Uhr für dich da.', { notify: false });
        ui.addContactMessage('Super, dann komme ich vorbei.').setState('sent');
        ui.showTyping();
      }
    }
    return () => {
      stage.textContent = '';
    };
  }, [previewTheme, view]);

  const accentText = onAccentColor(theme);
  const accentPreview = theme.gradient
    ? `linear-gradient(135deg, ${theme.color}, ${theme.color2})`
    : theme.color;

  return (
    <div className="wd">
      <div className="wd-controls">
        <Section
          title="Vorlagen"
          help="Ein Klick setzt Farben, Schrift und Form. Deine Texte bleiben, und du kannst danach alles einzeln anpassen."
        >
          <div className="wd-presets">
            {WIDGET_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                className="wd-preset"
                onClick={() => setTheme((current) => ({ ...current, ...preset.theme }))}
              >
                <span
                  className="wd-preset-swatch"
                  style={{
                    background: preset.theme.gradient
                      ? `linear-gradient(135deg, ${preset.theme.color}, ${preset.theme.color2})`
                      : preset.theme.color,
                  }}
                  aria-hidden="true"
                />
                {preset.label}
              </button>
            ))}
          </div>
        </Section>

        <Section title="Texte">
          <div className="stack">
            <Field label="Titel" htmlFor="wd-title" help="Steht oben im Chat, zum Beispiel dein Firmen- oder Teamname.">
              <input
                id="wd-title"
                name="title"
                type="text"
                required
                maxLength={WIDGET_LIMITS.title}
                value={theme.title}
                onChange={(event) => set('title', event.target.value)}
              />
            </Field>
            <Field
              label="Untertitel"
              htmlFor="wd-subtitle"
              help="Zweite Zeile mit grünem Punkt, zum Beispiel „Wir antworten in wenigen Minuten“. Leer lassen, wenn du keine willst."
            >
              <input
                id="wd-subtitle"
                name="subtitle"
                type="text"
                maxLength={WIDGET_LIMITS.subtitle}
                value={theme.subtitle}
                onChange={(event) => set('subtitle', event.target.value)}
              />
            </Field>
            <Field label="Begrüßung" htmlFor="wd-greeting" help="Die erste Nachricht in jedem neuen Chat.">
              <textarea
                id="wd-greeting"
                name="greeting"
                rows={3}
                maxLength={WIDGET_LIMITS.greeting}
                value={theme.greeting}
                onChange={(event) => set('greeting', event.target.value)}
              />
            </Field>
            <Field
              label="Schnellantworten"
              htmlFor="wd-reply-0"
              help="Bis zu vier Vorschläge unter der Begrüßung. Ein Klick sendet sie als erste Nachricht."
            >
              <div className="wd-replies">
                {replies.map((reply, index) => (
                  <input
                    key={index}
                    id={`wd-reply-${index}`}
                    name="quickReply"
                    type="text"
                    aria-label={`Schnellantwort ${index + 1}`}
                    placeholder={['Preise', 'Termin vereinbaren', 'Öffnungszeiten', 'Mit einem Menschen sprechen'][index]}
                    maxLength={WIDGET_LIMITS.quickReply}
                    value={reply}
                    onChange={(event) =>
                      setReplies((current) =>
                        current.map((entry, i) => (i === index ? event.target.value : entry))
                      )
                    }
                  />
                ))}
              </div>
            </Field>
            <Field label="Platzhalter im Eingabefeld" htmlFor="wd-placeholder">
              <input
                id="wd-placeholder"
                name="placeholder"
                type="text"
                maxLength={WIDGET_LIMITS.placeholder}
                value={theme.placeholder}
                onChange={(event) => set('placeholder', event.target.value)}
              />
            </Field>
          </div>
        </Section>

        <Section title="Farben">
          <SettingRow label="Hauptfarbe" htmlFor="wd-color" help="Chat-Button, Kopfzeile und deine Nachrichten.">
            <ColorField id="wd-color" name="color" value={theme.color} onChange={(value) => set('color', value)} />
          </SettingRow>
          <SettingRow label="Farbverlauf" htmlFor="wd-gradient" help="Die Hauptfarbe läuft in eine zweite Farbe über.">
            <input
              id="wd-gradient"
              name="gradient"
              type="checkbox"
              className="switch"
              checked={theme.gradient}
              onChange={(event) => set('gradient', event.target.checked)}
            />
          </SettingRow>
          {/* always submitted, so the second color survives switching the gradient off and on */}
          <div hidden={!theme.gradient}>
            <SettingRow label="Zweite Farbe" htmlFor="wd-color2">
              <ColorField id="wd-color2" name="color2" value={theme.color2} onChange={(value) => set('color2', value)} />
            </SettingRow>
          </div>
          <SettingRow
            label="Fenster"
            help="Automatisch folgt der Einstellung im Gerät deiner Besucher."
          >
            <Segmented
              label="Helles oder dunkles Chat-Fenster"
              name="scheme"
              value={theme.scheme}
              onChange={(value) => set('scheme', value as WidgetTheme['scheme'])}
              options={[
                { value: 'light', label: 'Hell' },
                { value: 'dark', label: 'Dunkel' },
                { value: 'auto', label: 'Automatisch' },
              ]}
            />
          </SettingRow>
          <p className="field-help wd-contrast">
            <span className="wd-contrast-chip" style={{ background: accentPreview, color: accentText }}>
              Aa
            </span>
            Die Schriftfarbe auf deiner Hauptfarbe wählt das Widget selbst, hell oder dunkel, damit der
            Text lesbar bleibt.
          </p>
        </Section>

        <Section title="Schrift">
          <SettingRow label="Schriftart" htmlFor="wd-font" help="Inter und Sora liefert Zendori selbst aus, ohne fremden Schriften-Dienst.">
            <select
              id="wd-font"
              name="font"
              value={theme.font}
              onChange={(event) => set('font', event.target.value as WidgetTheme['font'])}
            >
              {FONT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingRow>
          <div hidden={theme.font !== 'custom'}>
            <SettingRow
              label="Name der Schrift"
              htmlFor="wd-custom-font"
              help="Genau so, wie sie auf deiner Website eingebunden ist, zum Beispiel „Poppins“. Die Schrift muss dort geladen sein."
            >
              <input
                id="wd-custom-font"
                name="customFont"
                type="text"
                maxLength={WIDGET_LIMITS.customFont}
                value={theme.customFont}
                onChange={(event) => set('customFont', event.target.value)}
              />
            </SettingRow>
          </div>
          <SettingRow label="Schriftgröße">
            <Segmented
              label="Schriftgröße"
              name="fontSize"
              value={theme.fontSize}
              onChange={(value) => set('fontSize', value as WidgetTheme['fontSize'])}
              options={[
                { value: 'sm', label: 'Klein' },
                { value: 'md', label: 'Normal' },
                { value: 'lg', label: 'Groß' },
              ]}
            />
          </SettingRow>
        </Section>

        <Section title="Form und Position">
          <SettingRow label="Ecken">
            <Segmented
              label="Form der Ecken"
              name="radius"
              value={theme.radius}
              onChange={(value) => set('radius', value as WidgetTheme['radius'])}
              options={[
                { value: 'sharp', label: 'Eckig' },
                { value: 'soft', label: 'Weich' },
                { value: 'round', label: 'Rund' },
              ]}
            />
          </SettingRow>
          <SettingRow label="Position auf der Seite">
            <Segmented
              label="Position auf der Seite"
              name="position"
              value={theme.position}
              onChange={(value) => set('position', value as WidgetTheme['position'])}
              options={[
                { value: 'left', label: 'Unten links' },
                { value: 'right', label: 'Unten rechts' },
              ]}
            />
          </SettingRow>
          <SettingRow label="Abstand zum Rand" help="Seitlich und nach unten, in Pixeln.">
            <span className="wd-offsets">
              <input
                name="offsetX"
                type="number"
                aria-label="Abstand seitlich in Pixeln"
                min={WIDGET_LIMITS.offsetMin}
                max={WIDGET_LIMITS.offsetMax}
                value={theme.offsetX}
                onChange={(event) => set('offsetX', Number(event.target.value))}
              />
              <input
                name="offsetY"
                type="number"
                aria-label="Abstand nach unten in Pixeln"
                min={WIDGET_LIMITS.offsetMin}
                max={WIDGET_LIMITS.offsetMax}
                value={theme.offsetY}
                onChange={(event) => set('offsetY', Number(event.target.value))}
              />
            </span>
          </SettingRow>
        </Section>

        <Section title="Chat-Button">
          <SettingRow label="Stil">
            <Segmented
              label="Stil des Chat-Buttons"
              name="launcher"
              value={theme.launcher}
              onChange={(value) => set('launcher', value as WidgetTheme['launcher'])}
              options={[
                { value: 'icon', label: 'Nur Symbol' },
                { value: 'label', label: 'Symbol mit Text' },
              ]}
            />
          </SettingRow>
          <div hidden={theme.launcher !== 'label'}>
            <SettingRow label="Text auf dem Button" htmlFor="wd-launcher-label">
              <input
                id="wd-launcher-label"
                name="launcherLabel"
                type="text"
                maxLength={WIDGET_LIMITS.launcherLabel}
                value={theme.launcherLabel}
                onChange={(event) => set('launcherLabel', event.target.value)}
              />
            </SettingRow>
          </div>
          <SettingRow label="Symbol">
            <Segmented
              label="Symbol des Chat-Buttons"
              name="launcherIcon"
              value={theme.launcherIcon}
              onChange={(value) => set('launcherIcon', value as WidgetLauncherIcon)}
              options={(Object.keys(ICON_LABELS) as WidgetLauncherIcon[]).map((name) => ({
                value: name,
                label: <LauncherIcon name={name} />,
                ariaLabel: ICON_LABELS[name],
              }))}
            />
          </SettingRow>
          <SettingRow
            label="Hinweis neben dem Button"
            htmlFor="wd-teaser"
            help="Eine kleine Sprechblase lädt nach ein paar Sekunden zum Chatten ein. Sie erscheint einmal pro Besucher."
          >
            <input
              id="wd-teaser"
              name="teaser"
              type="checkbox"
              className="switch"
              checked={theme.teaser}
              onChange={(event) => {
                set('teaser', event.target.checked);
                if (event.target.checked) setView('closed');
              }}
            />
          </SettingRow>
          <div hidden={!theme.teaser}>
            <SettingRow label="Text des Hinweises" htmlFor="wd-teaser-text">
              <input
                id="wd-teaser-text"
                name="teaserText"
                type="text"
                maxLength={WIDGET_LIMITS.teaserText}
                value={theme.teaserText}
                onChange={(event) => set('teaserText', event.target.value)}
              />
            </SettingRow>
          </div>
        </Section>

        <Section title="Kopfzeile">
          <SettingRow label="Bild neben dem Titel">
            <Segmented
              label="Bild neben dem Titel"
              name="avatar"
              value={theme.avatar}
              onChange={(value) => set('avatar', value as WidgetTheme['avatar'])}
              options={[
                { value: 'none', label: 'Keins' },
                { value: 'icon', label: 'Symbol' },
                { value: 'initials', label: 'Initialen' },
                { value: 'image', label: 'Logo' },
              ]}
            />
          </SettingRow>
          <div hidden={theme.avatar !== 'image'}>
            <SettingRow
              label="Adresse des Logos"
              htmlFor="wd-avatar-url"
              help="Ein quadratisches Bild, erreichbar unter https://, zum Beispiel von deiner Website."
            >
              <input
                id="wd-avatar-url"
                name="avatarUrl"
                type="url"
                placeholder="https://…"
                maxLength={WIDGET_LIMITS.avatarUrl}
                value={theme.avatarUrl}
                onChange={(event) => set('avatarUrl', event.target.value)}
              />
            </SettingRow>
          </div>
          <SettingRow
            label="„Bereitgestellt von Zendori“"
            htmlFor="wd-branding"
            help="Kleiner Hinweis unter dem Eingabefeld."
          >
            <input
              id="wd-branding"
              name="branding"
              type="checkbox"
              className="switch"
              checked={theme.branding}
              onChange={(event) => set('branding', event.target.checked)}
            />
          </SettingRow>
        </Section>
      </div>

      <aside className="wd-preview" aria-label="Vorschau">
        <div className="wd-preview-head">
          <span className="wd-preview-title">Vorschau</span>
          {/* not a form field: only switches what the preview shows */}
          <span className="segmented" role="group" aria-label="Was die Vorschau zeigt">
            {(
              [
                ['start', 'Start'],
                ['chat', 'Gespräch'],
                ['closed', 'Geschlossen'],
              ] as [PreviewView, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`segmented-button${view === value ? ' segmented-button--active' : ''}`}
                aria-pressed={view === value}
                onClick={() => setView(value)}
              >
                {label}
              </button>
            ))}
          </span>
        </div>
        <div className="wd-browser">
          <div className="wd-browser-bar" aria-hidden="true">
            <i />
            <i />
            <i />
            <span>deine-website.de</span>
          </div>
          <div className="wd-page-mock" aria-hidden="true">
            <b />
            <span />
            <span />
            <span className="short" />
          </div>
          <div className="wd-stage" ref={stageRef} />
        </div>
        <p className="field-help">
          Das ist das echte Widget. Du kannst hineinschreiben, gesendet wird dabei nichts. Live geht
          dein Design erst mit „Design speichern“.
        </p>
      </aside>
    </div>
  );
}
