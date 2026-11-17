# App-Redesign „Ruhige Arbeitsfläche" — Vorschlag und Umsetzungsplan

Stand: 2026-11-17. Status: **Alle acht Stufen sind umgesetzt.** Committet auf dem Branch
`redesign/ruhige-arbeitsflaeche` (nicht gepusht), mit Ausnahme von fünf Seiten, die zusätzlich
noch nicht committete Feature-Arbeit tragen (Abschnitt 11). Kein Bildschirm wurde mit Login und
echten Daten geprüft; siehe dort. Alle Bausteine sind in der App unter `/admin/ui` zu sehen
(nur Plattform-Admins).

Visuelle Vorlage (Design-Canvas, 7 Boards): https://claude.ai/artifact/E3EmFgPweATuMTpDdr3ppr
Der Canvas ist privat. Wer ihn nicht öffnen kann, arbeitet nach diesem Dokument: Alle Werte
stehen hier.

| Board im Canvas | Zeigt |
| --- | --- |
| Inbox · Arbeitsfläche | Seitentyp A (drei Spalten, randlos) |
| Tickets · Listen-Seite | Seitentyp B (Kopf, Tabs, Leiste, Tabelle) |
| Ticket · Detail-Seite | Seitentyp C mit Seitenleiste rechts |
| Kanäle · Liste mit Anlegen-Drawer | Seitentyp B plus Drawer statt Galerie und Panel |
| Agent · Detail-Seite mit Tabs | Seitentyp C mit Seiten-Tabs und Speichern-Leiste |
| Einstellungen · Unternavigation | Seitentyp D (Unternavigation, Einstellungs-Zeilen) |
| Fundament · Tokens und Bausteine | Farben, Schrift, Radien, Bausteine |

## 1. Befund

Gemessen in `apps/web/src` am 2026-11-17:

- **482 Inline-Styles** (`style={{`) in den Seiten. Abstände, Schriftgrößen und Farben werden pro
  Seite neu gesetzt, deshalb sieht jede Seite etwas anders aus.
- **18 verschiedene Schriftgrößen** in `globals.css`, 11 weitere inline. 9 verschiedene Radien.
- **98-mal `.panel`**: Jeder Abschnitt ist eine schwebende Karte mit 24 px Radius und großem
  Schatten. Die Ticket-Detailseite stapelt fünf davon untereinander.
- **Vier Tab-Varianten** für dieselbe Aufgabe: `SettingsTabs`, `EditTabs`, `KnowledgeTabs`,
  `.inbox-tabs`. Drei Galerie-Komponenten: `ChannelGallery`, `KbGallery`, `IntegrationGallery`.
- **Bis zu vier Ebenen:** Sidebar → Einstellungen → Pillen-Tabs → Panel mit eigenen Tabs.
  Kanäle: Übersichts-Panel, darunter Kachel-Galerie, darunter ein Panel, das je Kachel aufklappt.
- **Anlegen und Auflisten auf derselben Seite**, dadurch lange Seiten und Querverweise
  („beantragst du unter Einstellungen → Telefonnummern").
- **Sidebar mit vier Gruppen und bis zu 16 Einträgen** (Admin), dazu im Fuß Organisations-Auswahl,
  Konto, Abmelden, Design-Schalter und Einklappen als fünf einzelne Controls.
- Einzelne Controls sind gar nicht gestaltet (Ticket-Detail: `<button type="submit">` ohne Klasse).

## 2. Leitregeln

1. **Höchstens zwei Navigationsebenen.** Ebene 1 ist die Sidebar. Ebene 2 ist genau eines von
   beidem: Seiten-Tabs oder die Unternavigation der Einstellungen. Keine Tabs in Karten, keine
   Galerie, die Panels aufklappt.
2. **Vier Seitentypen** (Abschnitt 5). Jede Seite ist genau einer davon.
3. **Linien statt Karten.** Abschnitte trennt eine 1-px-Linie und eine Überschrift. Schatten gibt es
   nur für Dinge, die über der Seite liegen: Menü, Drawer, Dialog.
4. **Anlegen passiert im Drawer**, ausgelöst von einem Button im Seitenkopf. Listen bleiben Listen.
5. **Ein Token-Satz.** Fünf Schriftgrößen, drei Radien, sechs Abstände. Kein Wert außerhalb davon.
6. **Kein Inline-Style** außer für echte Laufzeitwerte (zum Beispiel eine Kundenfarbe).

## 3. Tokens

Die bestehenden Variablennamen bleiben, wo die Bedeutung gleich ist. So wirkt Stufe 1 sofort auf
die ganze App, ohne dass eine Seite angefasst wird. Ersetzt den `:root`-Block in
`apps/web/src/app/globals.css`:

```css
:root {
  color-scheme: light;

  /* Flächen und Linien */
  --bg: #ffffff;              /* App-Grund, war #f8fafc */
  --surface: #ffffff;         /* Inhalt, Drawer, Felder */
  --surface-sunken: #f8fafc;  /* NEU: Sidebar, Hinweise, Tabellen-Hover */
  --surface-2: #f1f5f9;       /* Hover, Auswahl, neutrale Badges */
  --border: #e2e8f0;          /* Trennlinien */
  --border-strong: #cbd5e1;   /* Rahmen von Feldern und Buttons */

  /* Text */
  --ink: #0f172a;             /* Titel, Werte */
  --text: #334155;            /* Fließtext */
  --text-muted: #5b677a;      /* Hilfetext, Meta. War #64748b, das fällt auf --surface-2 unter 4,5:1 */
  --text-subtle: #94a3b8;     /* NUR Platzhalter und deaktivierte Icons, nie lesbarer Text */

  /* Akzent */
  --primary: #0b7480;         /* Primär-Button, Links, aktive Marker. Weiß darauf: 5,5:1 */
  --primary-strong: #105e69;  /* Hover */
  --primary-soft: #e6f6f5;    /* NEU: Akzent-Fläche (Badge „In Arbeit", KI-Hinweis) */
  --on-primary: #ffffff;      /* NEU */
  --link: var(--primary);

  /* Status: immer Paar aus Text und Fläche */
  --info: #1d4ed8;      --info-tint: #eff6ff;
  --success: #047857;   --success-tint: #ecfdf5;
  --warn: #b45309;      --warn-tint: #fffbeb;    --warn-border: #fde68a;
  --danger: #be123c;    --danger-tint: #fff1f2;  --danger-border: #fecdd3;

  /* Kanalfarben: nur für das kleine Kanal-Icon, nie als Textfarbe einer ganzen Zeile */
  --ch-email: #0b7480;    --ch-email-tint: #e0f5f4;
  --ch-form: #1d4ed8;     --ch-form-tint: #dbeafe;
  --ch-voice: #6d28d9;    --ch-voice-tint: #ede9fe;
  --ch-whatsapp: #15803d; --ch-whatsapp-tint: #dcfce7;
  --ch-chat: #c2410c;     --ch-chat-tint: #ffedd5;

  /* Schrift: Inter bleibt (next/font). Gewichte nur 400, 500, 600 */
  --fs-title: 20px;   --lh-title: 28px;   /* Seitentitel, 600 */
  --fs-heading: 16px; --lh-heading: 24px; /* Abschnitt, Spaltentitel, Drawer-Titel, 600 */
  --fs-body: 14px;    --lh-body: 20px;    /* Text, Felder, Buttons; Unterabschnitt = 600 */
  --fs-small: 13px;                       /* Sekundärtext, Hilfetext, Tabellenzellen */
  --fs-meta: 12px;    --lh-meta: 16px;    /* Badge, Tabellenkopf, Zeitstempel, 500 */
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace; /* 13px: Ticket-IDs, Adressen */

  /* Form */
  --r-sm: 6px;    /* Badge, Chip */
  --r: 8px;       /* Button, Feld, Nav-Eintrag */
  --r-lg: 12px;   /* Options-Gruppe, Nachricht, Hinweis */
  --r-full: 999px;/* Avatar, Schalter */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px; --space-8: 32px;

  /* Tiefe */
  --shadow-pop: 0 0 0 1px rgb(15 23 42 / 0.06), 0 12px 32px rgb(15 23 42 / 0.14);
  --ring: 0 0 0 3px rgb(11 116 128 / 0.25);

  --sidebar-w: 224px;
  --sidebar-w-collapsed: 56px;
}
```

Übergangs-Aliase für Stufe 1, in Stufe 8 löschen: `--r-xl: var(--r-lg)`, `--r-pill: var(--r)`,
`--shadow-sm: none`, `--shadow-card: none`, `--shadow-soft: var(--shadow-pop)`,
`--brand-gradient: var(--primary)`, `--success-ink: var(--success)`, `--info-ink: var(--info)`.

So umgesetzt in Stufe 1 (Abweichungen vom Block oben):

- Die Teal-Rampe `--brand-50` bis `--brand-900` und `--blue-600` bleiben als Alt-Tokens stehen,
  weil noch nicht umgestellte Regeln sie benutzen (Sidebar, Inbox, Kacheln, Dropzone). Neue Regeln
  benutzen nur `--primary*`. Löschen in Stufe 8.
- Von den `--sidebar-*`-Tokens bleibt seit Stufe 2 nur `--sidebar-text` (Schriftfarbe ruhender
  Einträge in Sidebar und Unternavigation) sowie die beiden Breiten 224 und 56.
- Zusätzlich `--hubspot`, `--hubspot-tint`, `--hubspot-border` (hell und dunkel), damit das
  HubSpot-Badge im dunklen Design nicht mehr hell leuchtet.
- Kanal-Badges benutzen jetzt dieselben Farben wie die Kanal-Kacheln: E-Mail Teal, Chat Orange
  (vorher E-Mail Blau, Chat Teal).
- Ein Absende-Button ohne Klasse (`button[type='submit']:not([class])`) sieht aus wie ein
  Sekundär-Button.

Dunkles Design: gleiche Namen, nur Werte tauschen. Startwerte, im Dunkel-Durchgang (Stufe 8) am
Bildschirm prüfen:

```css
:root[data-theme='dark'] {
  color-scheme: dark;
  --bg: #0f1726; --surface: #0f1726; --surface-sunken: #0b1220; --surface-2: #1a2438;
  --border: #243044; --border-strong: #35435f;
  --ink: #f1f5f9; --text: #cbd5e1; --text-muted: #9aa8bc; --text-subtle: #6b7a91;
  --primary: #2cc7c2; --primary-strong: #5eead4; --primary-soft: rgb(45 199 194 / 0.14);
  --on-primary: #04252a;
  --info: #93c5fd;    --info-tint: rgb(59 130 246 / 0.16);
  --success: #6ee7b7; --success-tint: rgb(16 185 129 / 0.14);
  --warn: #fbbf24;    --warn-tint: rgb(245 158 11 / 0.14);  --warn-border: rgb(245 158 11 / 0.4);
  --danger: #fda4af;  --danger-tint: rgb(244 63 94 / 0.16); --danger-border: rgb(244 63 94 / 0.45);
  --shadow-pop: 0 0 0 1px rgb(255 255 255 / 0.06), 0 12px 32px rgb(0 0 0 / 0.5);
  --ring: 0 0 0 3px rgb(45 199 194 / 0.35);
}
```

## 4. Bausteine

CSS: `globals.css` enthält Tokens, Grundelemente, Sidebar und den Baukasten; was nur ein
Bereich braucht, steht in `app/styles/<bereich>.css` (in `app/layout.tsx` nach `globals.css`
importiert). Kein Tailwind, keine neue Abhängigkeit. Dazu kommen kleine
React-Komponenten unter `apps/web/src/components/ui/`, damit die Inline-Styles verschwinden.
Alle außer `Drawer` und `Menu` sind reine Server-Komponenten ohne State.

| Baustein | Klasse / Komponente | Maße und Regeln |
| --- | --- | --- |
| Button | `.btn` + `--primary` `--secondary` `--ghost` `--danger`, Größen `--sm` `--icon`; `<Button>` | 36 hoch, Innenabstand 0 14, Radius 8, 14/500. `--sm`: 32 hoch, 13 px, nur in Leisten und Karten. Primär: `--primary` gefüllt. Sekundär: weiß mit `--border-strong`. Ghost: ohne Rahmen. Danger: weiß, Rahmen `--danger-border`, Text `--danger`. Kein Verlauf, kein Schatten, kein Anheben beim Hover. Fokus: `--ring`. **Ein Primär-Button pro Ansicht.** |
| Badge | `.badge` + `--neutral` `--accent` `--info` `--success` `--warn` `--danger`, optional `--dot`; `<Badge>` | 22 hoch, Radius 6, 12/500. Ersetzt `.tile-status*`, die Inbox-Pillen und `badge--muted`. `channelBadgeClass()` und `badge--hubspot` bleiben als Töne erhalten. |
| Kanal-Icon | `.ch-icon` + `--email` `--form` `--voice` `--whatsapp` `--chat`; `<ChannelIcon type>` | 24 × 24 (Listen) oder 32 × 32 (Kanal-Tabelle), Radius 6 bzw. 8, Fläche `--ch-*-tint`, Icon `--ch-*`. Der Kanalname daneben ist normaler Text. |
| Feld | `.field` (Label, Control, `.field-help`, `.field-error`); `<Field label help error>` | Label 13/500 über dem Control, Abstand 6. Control 36 hoch, Radius 8, Rahmen `--border-strong`. Fehler: Rahmen und Text `--danger`, `aria-invalid`. Formulare höchstens 720 breit. |
| Schalter | `input[type=checkbox].switch` | 36 × 20, an = `--primary`. Reines CSS (`appearance: none`), funktioniert in Server-Action-Formularen. |
| Options-Gruppe | `.option-group` > `label.option` | Radio-Zeilen in einem Rahmen (Radius 12), Linie zwischen den Zeilen, gewählte Zeile `--surface-sunken`. Für 2 bis 6 Alternativen mit Erklärung (Antwortmodus, Eskalationsziel, Kanaltyp). |
| Einstellungs-Zeile | `.setting-row`; `<SettingRow label help>` | Links Label 14/500 und Hilfe 13 gedämpft, rechts das Control. Linie darunter, Innenabstand 16 0. |
| Abschnitt | `.section`; `<Section title help actions>` | Überschrift 16/600, Hilfe 13 gedämpft, Inhalt. Abstand zwischen Abschnitten 32. **Kein Rahmen, kein Hintergrund.** Ersetzt `.panel`. |
| Eigenschaften | `.props` > `.prop`; `<PropertyList>` | Zeile 32 hoch (44, wenn ein Control drin sitzt), Label links gedämpft, Wert rechts `--ink`, 13 px. Für Seitenleisten. |
| Tabs | `.tabs` > `a` oder `button`, aktiv `aria-current="page"` oder `aria-selected="true"`; `<Tabs>` | Unterstrichen: 40 hoch, Abstand 24, aktiv 2 px `--primary` und 600. Zähler dahinter in 400 gedämpft. Ersetzt `.tabbar`, `EditTabs`-Optik, `KnowledgeTabs`, `.inbox-tabs`. |
| Unternavigation | `.subnav` > `a`; `<SubNav>` | Senkrechte Liste, 208 breit, Einträge 36 hoch, aktiv `--surface-2` und 600. Nur in Einstellungen und Plattform. Ersetzt `SettingsTabs`. |
| Tabelle | `<table>` (global gestaltet), außen `.table-wrap`; Zellen-Helfer `.cell-main`, `.cell-title`, `.cell-sub`, `.cell-actions` | Kopf 36 hoch, 12/500 gedämpft. Zeilen mindestens 56, Linie darunter, Hover `--surface-sunken`. Kein Außenrahmen. Erste Spalte trägt den Link. `.table-wrap` scrollt waagerecht. |
| Hinweis | `.callout` + `--info` `--warn` `--danger` `--success`; `<Callout>` | Radius 12, Icon links, 13 px. Ersetzt `.notice` und `.error`. `.hint` und `.help` werden zu **einer** Klasse `.help` (13 px gedämpft). `DismissibleBanners` rendert Callouts. |
| Drawer | `<Drawer title footer closeHref>` | Rechts, 460 breit, volle Höhe, `--shadow-pop`, Abdunklung `rgb(15 23 42 / 0.32)`. Kopf 56 mit Schließen-Button, Fuß mit Abbrechen und Primär-Button. **Geöffnet über die URL** (`?panel=new`), Schließen ist ein Link ohne den Parameter. So bleiben Seiten Server-Komponenten. Client-Anteil nur für Escape und Fokus. |
| Menü | `<Menu>` für „⋯" | Kleines Client-Popover, `--shadow-pop`, Einträge 36 hoch. Hier landen seltene und gefährliche Aktionen (Löschen). `ConfirmDeleteButton` bleibt zweistufig, wird aber aus dem Menü ausgelöst. |
| Leerzustand | `.empty`; `<EmptyState title text action>` | Mittig, Titel 16/600, ein Satz, ein Button. Ersetzt die losen grauen Absätze. |
| Avatar | `.avatar` | 28 oder 36, rund, Initialen 12/600 auf `--border`. |

Alt-Klassen `button.primary`, `.ghost`, `button.danger` bekommen in Stufe 1 die neue Optik
(`.ghost` = Sekundär) und werden in den Stufen 4 bis 7 durch `<Button>` ersetzt.

### 4.1 Die Bausteine im Code (Stand Stufe 3)

Alles liegt unter `apps/web/src/components/ui/`, das CSS im Abschnitt „UI kit" von `globals.css`.
Jede Datei beginnt mit einem Kommentar samt Anwendungsbeispiel. Lebende Referenz: `/admin/ui`
(`apps/web/src/app/admin/ui/page.tsx`), dort ist jeder Baustein einmal verbaut.

| Datei | Export | Wofür |
| --- | --- | --- |
| `Button.tsx` | `Button` (default), `buttonClass()` | Button oder Link im Button-Look. `variant`: primary, secondary (Standard), ghost, danger. `size="sm"`, `icon`, `iconOnly` (dann `aria-label`). Ohne `href` ist `type` Pflicht. |
| `Badge.tsx` | `Badge` | `tone`: neutral, muted, accent, info, success, warn, danger, hubspot. `dot` für Lebenszyklus-Status. |
| `Callout.tsx` | `Callout` | `tone`: info, success, warn, danger. Optional `title` und `action`. |
| `Field.tsx` | `Field`, `SettingRow`, `OptionGroup` | Feld mit Label, Hilfe, Fehler. Einstellungs-Zeile. Options-Gruppe als Radios (`name`) oder als Links (`href` je Option, Auswahl in der URL). |
| `Layout.tsx` | `Section`, `PropertyList`, `Property`, `EmptyState`, `Tabs`, `Avatar` | Abschnitt ohne Rahmen, Eigenschaften-Zeilen, Leerzustand, Seiten-Tabs als Links, Initialen. |
| `ChannelIcon.tsx` | `ChannelIcon` | `kind`: email, form, webform, voice, whatsapp, chat, test. `size="md"` für Tabellen. |
| `PageHeader.tsx` | `PageHeader` | `title`, `subtitle`, `breadcrumb`, `badges`, `actions`, `tabs`. |
| `SubNav.tsx` | `SubNav` | Unternavigation (Client, aktiv über den Pfad). |
| `Drawer.tsx` | `Drawer` | Client. `title`, `closeHref`, `footer`. Öffnen über `?panel=…`. |
| `Menu.tsx` | `Menu` | Client. „⋯"-Button, Einträge mit Klasse `menu-item` (gefährlich: `menu-item--danger`). |
| `Icon.tsx` | `Icon`, `IconName` | Das eine Icon-Set. Neue Icons hier ergänzen, nirgends sonst SVG einbetten. |
| `useDismiss.ts` | `useDismiss` | Schließt ein Popover bei Klick daneben und Escape. |

Seit Stufe 8 dazu: `AuthCard.tsx` (Login, Onboarding, Einladung, Organisations-Auswahl),
in `Layout.tsx` `Stats`/`Stat` und `CodeBlock`, in `lib/href.ts` der Helfer `href()`.

Nur CSS, ohne Komponente: `input.switch`, `.switch-btn` (Schalter als Absende-Button),
`.toolbar` (+ `.toolbar-end`), `.table-wrap`, `.cell-*`, `.cell-buttons`, `.table--compact`,
`.table-sum`, `.num`, `input.num-input`, `.form-narrow`, `.field--short`, `.field-row`,
`.fieldset-plain`, `.link-button`, `.tabs--line`, `.banners`, `.page-notices`, `.page-notice`,
`.page-note`, `.menu-note`, `.steps`, `.disclosure`, die Layout-Helfer `.row`, `.stack--sm`,
`.stack--lg`, `.muted`, `.small`, `.grow`, `.truncate`, `.sr-only` und die Seitentypen `.page`,
`.page-body`, `.page-split`, `.page-rail`, `.rail-section`, `.page-form`, `.page-tabs`,
`.save-bar`.

Regeln für die Stufen 4 bis 7:

- Seiten benutzen **nur** diese Bausteine. Fehlt etwas, wird der Baukasten erweitert (Komponente
  plus CSS im Abschnitt „UI kit" plus ein Beispiel auf `/admin/ui`), nicht die Seite mit
  Inline-Styles geflickt.
- Ein Formular im Drawer bekommt eine `id`; der Absende-Button im Fuß zeigt mit `form="…"` darauf.
- Server-Actions leiten nach Erfolg auf die Liste ohne `panel` um (Drawer zu, Erfolgsmeldung).
  Bei einem Fehler leiten sie mit `panel=…` und `error=…` zurück, damit der Drawer offen bleibt.
- Löschen in einem `Menu` ist ein `<form action={…}>` mit `<button className="menu-item
  menu-item--danger" type="submit">`. Das Menü bleibt dabei offen, bis die Action umleitet.
- `DismissibleBanners` bleibt die eine Stelle für `?notice=` und `?error=` und steht direkt unter
  dem `PageHeader` im `.page-body`.

## 5. Seitentypen

Gemeinsamer Kopf für B, C und D: `<PageHeader title subtitle? breadcrumb? badges? actions? tabs? />`.
Innenabstand 20 32, Linie darunter. Titel 20/600, Untertitel **ein Satz** in 13 px gedämpft.
Aktionen rechts, Primär-Button ganz rechts außen vor dem Menü.

**A · Arbeitsfläche** (nur `/inbox`). Volle Höhe, drei Spalten, getrennt durch Linien, kein
Außenabstand, keine Karten. Jede Spalte hat einen 56 px hohen Kopf auf gleicher Linie.
Spalten: Liste 300, Verlauf flexibel, Details 280.

**B · Liste** (Tickets, Kanäle, Agenten, Wissen, Formulare, Team, Textbausteine).

```tsx
<div className="page">
  <PageHeader title="Kanäle" subtitle="…" actions={<Button href="?panel=new">Neuer Kanal</Button>} />
  <div className="toolbar">{/* Suche 280 breit, Filter als Sekundär-Buttons */}</div>
  <div className="table-wrap"><table className="table">…</table></div>
  {panel === 'new' ? <Drawer title="Neuer Kanal" …>…</Drawer> : null}
</div>
```

**C · Detail** (Ticket, Agent, Kanal, Wissensdatenbank, Quelle, Formular). Kopf mit Pfad
(„Tickets / ZD-1042"), Titel, Status-Badges, Aktionen. Darunter eines von beidem:
Hauptspalte plus Seitenleiste (320, Linie links, `PropertyList`) für Objekte mit Verlauf, oder
Seiten-Tabs plus Formular (höchstens 720 breit) für Objekte mit vielen Einstellungen. Formulare
enden in einer Speichern-Leiste, die unten kleben bleibt (`position: sticky; bottom: 0`, Linie oben).

**D · Einstellungen** (`/settings/organization` und Geschwister, `/admin/*`). Links über die
volle Höhe die `SubNav`, rechts eine normale Seite vom Typ B oder C mit eigenem `PageHeader`.
(Abweichung vom Canvas-Board, das einen gemeinsamen Kopf „Einstellungen" über beidem zeigt:
so sind Einstellungen und Plattform gleich gebaut und jede Seite bleibt eine normale Seite.)

Gerüste mit den echten Bausteinen (alle drei stehen so auf `/admin/ui`):

```tsx
// C mit Seitenleiste (Ticket)
<div className="page">
  <PageHeader breadcrumb={[{ label: 'Tickets', href: listHref }, { label: ticket.display_id }]}
    title={ticket.subject} badges={<Badge tone="info" dot>Offen</Badge>}
    actions={<><Menu>…</Menu><Button type="submit" form="resolve" variant="primary">Als erledigt markieren</Button></>} />
  <div className="page-split">
    <div className="page-body">
      <DismissibleBanners error={error} notice={notice} />
      <Section title="Beschreibung" actions={<Link href="?panel=edit">Bearbeiten</Link>}>…</Section>
      <Section title="Verlauf">…</Section>
    </div>
    <aside className="page-rail" aria-label="Eigenschaften">
      <div className="rail-section"><h2>Bearbeitung</h2><PropertyList>…</PropertyList></div>
    </aside>
  </div>
</div>

// C mit Tabs und Formular (Agent)
<form className="page" action={updateAgent}>
  <PageHeader breadcrumb={…} title={agent.name} badges={…} actions={<Menu>…</Menu>} tabs={…} />
  <div className="page-body"><div className="form-narrow">
    <Section title="Antwortmodus" help="…"><OptionGroup label="Antwortmodus" name="mode" … /></Section>
    <Section title="…"><SettingRow label="…" help="…" htmlFor="x"><input id="x" className="switch" type="checkbox" /></SettingRow></Section>
  </div></div>
  <div className="save-bar"><Button type="submit" variant="primary">Speichern</Button></div>
</form>

// D (Einstellungen, Plattform): SubNav im layout.tsx des Bereichs
<div className="with-subnav">
  <SubNav label="Einstellungen" items={…} />
  <div className="with-subnav-content">{children /* eine Seite vom Typ B oder C */}</div>
</div>
```

## 6. Navigation

**Routen bleiben unverändert.** Geändert wird nur, was die Sidebar zeigt (`AppShell.tsx`, `NAV`).
Die Rechteprüfung `NAV_ACCESS` bleibt, wie sie ist.

| Gruppe | Einträge | Route |
| --- | --- | --- |
| (ohne Titel) | Inbox, Tickets, jeweils mit Zähler | `/inbox`, `/tickets` |
| Einrichten | Agenten, Wissen, Kanäle, Formulare | `/settings/agents`, `/settings/knowledge`, `/settings/channels`, `/settings/forms` |
| Organisation | Team, Einstellungen | `/settings/members`, `/settings` |
| (nur Plattform-Admins) | Plattform | `/admin` |

- **Kopf der Sidebar:** Logo-Icon, Name der Organisation, Pfeil. Ein Klick öffnet die Auswahl der
  Organisation. Ersetzt den 68 px hohen Logo-Kopf und das `<select>` im Fuß.
- **Fuß der Sidebar:** eine Zeile mit Avatar, Name, Rolle und „⋯". Im Menü: Design
  (Automatisch, Hell, Dunkel), Sidebar einklappen, Abmelden.
- **Aktiver Eintrag:** weiße Fläche mit 1-px-Linie, Text `--ink`, Icon `--primary`.
- **Gruppe „Werkzeuge" entfällt.** MD-Generator: Sekundär-Button im Kopf von Wissen.
  Test-Channel: Sekundär-Button „Testnachricht" im Kopf von Kanäle. Widget-Demo: Link auf der
  Detailseite eines Chat-Kanals.
- **Gruppe „Zendori" (5 Einträge) wird ein Eintrag „Plattform".** Die fünf Admin-Seiten bekommen
  eine `SubNav` mit den Titeln der Seiten: Nutzer, Telefonnummern, Demo-Anrufe, Abrechnung,
  Preise & Pakete.

So umgesetzt in Stufe 2:

- `AppShell.tsx`: `OrgSwitcher` (oben), drei Gruppen, `AccountMenu` (unten). Beide Menüs sind
  `position: fixed`, damit das `overflow: hidden` der Sidebar sie nicht abschneidet, auch
  eingeklappt. Das Konto-Menü bleibt geschlossen im DOM, damit `ThemeToggle` in „Automatisch"
  weiter dem Betriebssystem folgt.
- Bei nur einer Organisation ist der Kopf ein Link zur Inbox ohne Pfeil.
- `/tools/md-generator` markiert „Wissen" als aktiv, `/test-channel` markiert „Kanäle". Beide
  Seiten haben einen Pfad im Seitenkopf als Rückweg.
- `app/admin/layout.tsx` rendert die `SubNav` und prüft `requirePlatformAdmin()` selbst.
- Die Zähler an Inbox und Tickets kamen nach Stufe 3 dazu (Abschnitt 10, Punkt 4).
- `PageHeader` ist ein `<div>`, kein `<header>`: Die Alt-Regel `.shell > header a` (Seiten ohne
  Rahmen: `/`, `/widget-demo`) würde sonst jeden Link darin umfärben.
- Der Seitenrahmen alter Seiten hängt an `.app-main .shell` (linksbündig, Kopf über die volle
  Breite, Inhalt höchstens 72rem). Neue Seiten benutzen `.page` (seit Stufe 3 vorhanden); beide
  bestehen nebeneinander, bis die letzte Seite umgestellt ist.

## 7. Seite für Seite

| Seite | Typ | Was sich ändert |
| --- | --- | --- |
| `/inbox` | A | `.inbox-col` verliert Rahmen, Radius, Schatten und Außenabstand. Status-Filter als Tabs mit Zähler, Kanalfilter als Button im Listenkopf. „Übernehmen" und „An Bot zurückgeben" wandern aus der Seitenleiste in den Kopf des Verlaufs, daneben ein Badge mit Agent und Modus. `ContextSidebar`: fünf Abschnitte mit `PropertyList` (Kontakt, Konversation, Tickets, HubSpot, Notizen). `SuggestedReply` als eine Karte mit Konfidenz-Badge und drei Buttons. |
| `/tickets` | B | Status als Tabs mit Zählern statt Filterfeld. Tabelle ohne Panel. Herkunft als zweite Zeile unter dem Betreff. |
| `/tickets/[id]` | C mit Seitenleiste | Fünf Panels werden zu Hauptspalte (Beschreibung, Verlauf) und Seitenleiste (Bearbeitung, Details, Kontakt, HubSpot). Betreff steht nur noch im Titel. Bearbeiten von Betreff und Beschreibung im Drawer (`?panel=edit`). Löschen im Menü. |
| `/settings/agents` | B | Panel „Übersicht" und Anlegen-Formular darunter werden Tabelle plus Drawer „Neuer Agent". |
| `/settings/agents/[id]` | C mit Tabs | `EditTabs` bleibt in der Logik (alle Abschnitte gemountet, ein `<form>`), sieht aber aus wie Seiten-Tabs direkt unter dem Kopf. Kein Panel. Radios als Options-Gruppen. Löschen im Menü. Speichern-Leiste. |
| `/settings/knowledge` | B | `KbGallery` wird eine Tabelle der Wissensdatenbanken. Drawer „Neue Wissensdatenbank". |
| Wissensdatenbank (heute Auswahl in der Galerie) | C mit Tabs | Tabs: Quellen, Gelernte Antworten, Einstellungen. „Quelle hinzufügen" öffnet einen Drawer mit Options-Gruppe (Website, Datei, Text, Fragen und Antworten als CSV). Ersetzt `KnowledgeTabs`. Vor dem Umbau prüfen, wie `KbGallery` heute auswählt; bevorzugt eigene Route `/settings/knowledge/[kbId]`. |
| `/settings/channels` | B | `ChannelGallery` und die sieben Anlegen-Panels entfallen. Drawer „Neuer Kanal": erst Options-Gruppe Kanaltyp, darunter die Felder dieses Typs. Telefon und Web-Formular zeigen im Drawer nur Erklärung und Link, wie heute. |
| `/settings/channels/[id]` | C | Abschnitte statt Panels und statt aufklappbarer Blöcke. Mehr als drei Abschnitte: Tabs (Allgemein, Einbetten, Erweitert). |
| `/settings/forms`, `/settings/forms/[id]` | B, C | Liste plus Drawer. Der Builder behält seine zwei Spalten, bekommt Tokens, `.tabs` und die Speichern-Leiste. |
| `/settings/members` | B | Tabelle plus Drawer „Mitglied einladen" (`TeamMemberForm`). |
| `/settings/organization`, `phone-numbers`, `ai`, `tickets`, `canned-responses`, `integrations`, `billing` | D | `SettingsTabs` wird `SubNav`. Panels werden Abschnitte mit Einstellungs-Zeilen. Textbausteine: Tabelle plus Drawer. Integrationen: Zeilen mit Status-Badge und Button statt `IntegrationGallery`. |
| `/admin/*` | D | Gleiche Bausteine, `SubNav` „Plattform". |
| `/login`, `/register`, `/onboarding`, `/invite/*` | — | Nur Tokens: Karte mit Linie statt Schatten, Radius 12, ruhiger Hintergrund ohne Raster-Verlauf. |

**Nicht anfassen:** `/f/[token]`, `/demo`, `/widget-demo`-Inhalt, `widget.js`, `form.js`, `demo.js`
und ihre Quellordner. Diese Flächen haben eigenes, kundengesteuertes Design.

## 8. Umsetzung in Stufen

Jede Stufe ist einzeln auslieferbar. Am Ende jeder Stufe gilt CLAUDE.md §8: `pnpm typecheck &&
pnpm lint && pnpm test` grün, kurze Testanleitung, dann **STOP** und auf „weiter" warten.
Keine Migration, kein Worker-Deploy, keine neue Abhängigkeit in irgendeiner Stufe.

1. **Tokens und Grundelemente.** Nur `globals.css`: neuer `:root`-Block mit Aliasen, dunkler Block,
   neue Optik für `button.primary`, `.ghost`, `button.danger`, Felder, `label`, `.badge`, `table`,
   `.notice`, `.error`, `.hint`, `.help`, `.panel` (vorerst: kein Schatten, Radius 12, Linie).
   Erwartung: keine Verläufe, keine Pillen-Buttons, keine Kartenschatten mehr, sonst nichts kaputt.
2. **Rahmen.** `AppShell.tsx`: Gruppen aus Abschnitt 6, Kopf mit Organisations-Auswahl, Konto-Menü
   im Fuß, „Plattform" statt fünf Admin-Einträgen. `.page`, `PageHeader`.
3. **Bausteine.** `components/ui/*` und das zugehörige CSS aus Abschnitt 4. Noch keine Seite
   umgestellt. `DismissibleBanners` auf `Callout`.
4. **Listen-Seiten.** Reihenfolge: Tickets, Kanäle, Agenten, Team, Formulare, Textbausteine, Wissen.
   Server-Actions bleiben unverändert, nur ihre Formulare ziehen in Drawer um.
5. **Detail-Seiten.** Ticket, Agent, Kanal, Wissensdatenbank, Quelle, Formular-Builder.
6. **Einstellungen und Plattform.** `SubNav`, Abschnitte, Einstellungs-Zeilen.
7. **Inbox.** Zuletzt, weil am meisten genutzt und mit Realtime verknüpft. `RealtimeRefresher`
   und alle Actions bleiben unangetastet.
8. **Aufräumen.** Tote Klassen löschen (`.panel`, `.tile-*`, `.tabbar`, `.chan-*`, `.shell`,
   Aliase aus Abschnitt 3), `ChannelGallery`, `KbGallery`, `IntegrationGallery`, `KnowledgeTabs`,
   `SettingsTabs` entfernen. Dunkles Design am Bildschirm prüfen. Auth-Seiten angleichen.

Messbare Ziele nach Stufe 8:

- `grep -r 'style={{' apps/web/src --include='*.tsx' | wc -l` unter 30 (heute 482), übrig nur
  Laufzeitwerte.
- In `globals.css` nur noch die fünf Schriftgrößen aus Abschnitt 3 (plus 13 px Mono).
- Kein `className="panel"` mehr.
- Jede Seite hat genau einen `PageHeader` und höchstens einen Primär-Button.

## 9. Leitplanken

- Stack bleibt: Next 15, Server-Komponenten, Server-Actions, eine globale CSS-Datei. Kein Tailwind,
  keine UI-Bibliothek, keine neue Abhängigkeit.
- Keine Änderung an Routen (Ausnahme: die eine optionale Route für Wissensdatenbanken), an
  Rechteprüfungen (`requireActiveOrg`, `canViewArea`, `NAV_ACCESS`), an Actions oder an Daten.
- UI-Texte Deutsch, Code und Kommentare Englisch (CLAUDE.md §8.7).
- Bedienbarkeit: echte `<button>`, `<a>`, `<label>`; Icon-Buttons mit `aria-label`; sichtbarer
  Fokus (`--ring`); Text mindestens 4,5:1 auf seinem Grund, in beiden Designs.
- Icons: die vorhandenen Inline-SVGs aus `AppShell.tsx` in `components/ui/Icon.tsx` bündeln,
  16 px in der Navigation und in Buttons, Strichstärke 1,8. Keine Emoji und keine Zeichen wie
  „⚠", „←", „↑" als Icons.
- Seitentexte kürzen: Untertitel ist ein Satz. Erklärungen stehen als Hilfetext am Feld, nicht als
  Absatz über der Seite. Verweise auf andere Seiten sind Links, keine Wegbeschreibungen.

## 10. Offene Entscheidungen (Owner)

1. **Akzentfarbe der Buttons.** Entschieden am 2026-11-17: dunkles Teal `#0b7480` ohne Verlauf.
   Der Verlauf Teal → Blau bleibt dem Logo und der Website vorbehalten.
2. **Interne Notizen im Verlauf.** Im Vorschlag bleiben Notizen in der rechten Spalte (kein
   Verhaltenswechsel). Möglich wäre ein Umschalter „Antwort | Notiz" im Eingabefeld, dann
   erscheinen Notizen im Verlauf. Das wäre ein eigenes kleines Feature.
3. **Startseite „Übersicht".** Nicht Teil dieses Plans. Eine Seite mit offenen Konversationen,
   wartenden Tickets und Autopilot-Quote ließe sich mit denselben Bausteinen später ergänzen.
4. **Zähler in der Sidebar.** Umgesetzt wie vorgeschlagen: Inbox = Konversationen mit Status
   „wartend", Tickets = offen plus in Arbeit. Aktualisiert bei jeder Navigation, bei Fensterfokus
   und einmal pro Minute.

## 11. Umsetzungsstand (2026-11-17)

**Messwerte**

| Ziel aus Abschnitt 8 | Ergebnis |
| --- | --- |
| Inline-Styles unter 30 (vorher 482) | 8: sieben auf den öffentlichen Seiten `/f/[token]` und `/demo` (bewusst unangetastet), einer als Laufzeitwert im `Menu` |
| nur noch die Schriftgrößen aus Abschnitt 3 | in `globals.css` erfüllt |
| kein `className="panel"` | erfüllt, ebenso `shell`, `tabbar`, Kacheln, alte Button-Klassen |
| ein `PageHeader`, höchstens ein Primär-Button je Ansicht | erfüllt bis auf zwei Stellen (siehe unten) |
| `globals.css` | 2709 → 2150 Zeilen, dazu 8 Bereichs-Dateien mit zusammen rund 1050 Zeilen |

`pnpm typecheck`, `pnpm lint`, `pnpm test` und `next build` (59 Routen) sind grün. Der
Branch-Stand kompiliert auch für sich allein, ohne die offene Feature-Arbeit.

**Commits auf `redesign/ruhige-arbeitsflaeche`:** Stufen 1 bis 3, Sidebar-Zähler,
Baukasten-Ergänzungen, Seiten außerhalb des Rahmens, Stufe 8 (Aufräumen), dann je ein Commit für
Tickets-Liste, Kanäle, Agenten, Wissen, Formulare und Team, Einstellungen, Plattform, Inbox.

**Noch nicht committet (Redesign fertig, aber vermischt mit offener Feature-Arbeit):**

| Datei | trägt außerdem |
| --- | --- |
| `app/tickets/[ticketId]/page.tsx`, `lib/tickets/queries.ts`, `lib/tickets/types.ts` | Ticket-Vorgeschichte |
| `app/settings/phone-numbers/page.tsx` | Status `failed` (0033); committet ist die Fassung ohne ihn |
| `app/admin/phone-numbers/**` | Nummernbestellung (0033) |
| `app/admin/demo/**`, Eintrag „Demo-Anrufe" in `app/admin/layout.tsx`, `/demo` in `AppShell.tsx` | Demo-Anruf (0032) |

Folge: Im Branch-Stand allein zeigen Ticket-Detail und Plattform-Telefonnummern noch ihr altes
Markup, für das es kein CSS mehr gibt. **Den Branch erst zusammenführen, wenn die Feature-Arbeit
mitcommittet ist.** In der Arbeitskopie ist alles vollständig.

**Bewusste Verhaltensänderungen** (alle Actions, Feldnamen und Rechteprüfungen sind unverändert)

- Überall: Anlegen und Bearbeiten im Drawer (`?panel=…`); ein Eingabefehler führt zurück in den
  offenen Drawer. Löschen liegt im „⋯"-Menü und ist zweistufig. Meldungen aus `?notice=` und
  `?error=` blenden sich auf allen Seiten selbst aus.
- Tickets: Primär-Button „Als erledigt markieren" im Kopf der Detailseite; Link „Zurücksetzen" bei
  aktivem Filter; Zähler an den Status-Tabs (bei Suche ausgeblendet); der Verlauf steht in der
  Seite statt in einem Kasten mit eigener Scroll-Leiste.
- Inbox: Status und Kanalfilter senden beim Ändern ab; „Übernehmen", „Zurückgeben" und „Entwurf
  anfordern" stehen im Kopf des Verlaufs; Zeilen zeigen „Bot" oder „Mensch"; Systemnachrichten
  sind umrandet statt gefüllt; unter 1100 px rückt die Kontext-Spalte unter den Verlauf.
- Kanäle: Kanaltyp wird im Drawer gewählt; Detailseite mit Tabs je Kanalart; die zwei
  Voice-Häkchen sind Schalter; „Neuer Kanal" sehen auch Mitglieder ohne Recht (mit Hinweis).
- Agenten: Typ, Modus und Eskalationsziel als Auswahlgruppen statt Auswahllisten; Hilfetexte
  gekürzt, Wegbeschreibungen sind Links.
- Wissen: neue Route `/settings/knowledge/[kbId]`; Aktionen an Quellen und „In Wissensdatenbank
  speichern" des MD-Generators landen auf der Seite dieser Wissensdatenbank statt auf der Liste.
- Formulare und Team: Formular löschen über Menü und Drawer mit Namensbestätigung; „Feld
  duplizieren" steht im geöffneten Feld; Mitglied entfernen ist zweistufig.
- Einstellungen: Unternavigation statt Tabs; Textbausteine zeigen Anlegen, Bearbeiten und Löschen
  nur mit Bearbeiten-Recht; Eskalations-Keywords bleiben ein Textfeld mit Kommas.
- Plattform: Rollen heißen einheitlich Inhaber, Admin, Mitarbeiter; ein Demo-Anruf öffnet seine
  Details mit Transkript im Drawer.
- Sidebar: Zähler an Inbox (wartend) und Tickets (offen plus in Arbeit).

**Zwei Stellen mit mehr als einem gefüllten Button:** In der Inbox können „Übernehmen" am
Antwortvorschlag und „Senden" gleichzeitig sichtbar sein. Auf „Preise & Pakete" ist dafür kein
Button primär, weil jeder Block seinen eigenen Speichern-Button hat.

**Nicht geprüft**

- Keine Seite wurde mit Login und echten Daten in der laufenden App gesehen (kein Testzugang).
  Geprüft wurde so: Die echten Seiten-Komponenten wurden je Bereich mit Beispieldaten in Chrome
  gerendert, hell und dunkel, mit geöffneten Drawern und Menüs. Die Login-Seite lief in der echten
  App.
- Keine Server-Action wurde ausgeführt. Ungetestet sind damit vor allem die neuen Rücksprünge in
  den Drawer nach einem Fehler und die neuen Ziele nach dem Speichern (Wissen, Kanal-Tabs).
- Fensterbreiten unter 900 px nur stichprobenhaft.

**Offen für den Owner**

1. Feature-Arbeit committen, damit die fünf gemischten Seiten folgen können.
2. Platzhalter mit Kundennamen („z. B. Kontaktformular strong-energy.eu" und ähnliche) neutral
   fassen? Im Onboarding ist das schon geschehen.
3. „Neue Wissensdatenbank", „Quelle hinzufügen" und „Neuer Kanal" für Mitglieder ohne
   Bearbeiten-Recht ausblenden? Heute sichtbar, die Action lehnt ab.
4. Soll die Agent-Auswahl am Kanal beim Ändern sofort speichern?
5. Inbox-Liste ist 280 bis 320 px breit statt 300, damit fünf Status-Tabs in eine Zeile passen.
6. Weiterhin offen aus Abschnitt 10: Notizen im Verlauf, Startseite „Übersicht".
