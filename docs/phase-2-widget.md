# Phase 2 — Chat-Widget

Stand: 2026-07-13. Embeddables Chat-Widget mit anonymen Sessions, Realtime in beide Richtungen und Theming pro Org.

## Einbindung (Kundenseite)

Ein Script-Tag, kein weiterer Code:

```html
<script src="https://<APP_URL>/widget.js" data-zendori-token="<PUBLIC_TOKEN>" async></script>
```

Das Snippet (inkl. Token) steht unter **Einstellungen → Kanäle** am jeweiligen Widget-Channel. Der Token ist öffentlich — er identifiziert nur den Kanal, autorisiert aber nichts über die Session hinaus. Optional: `data-zendori-url`, falls die API nicht am Script-Origin liegt.

## Architektur

- **Widget-Channel** = `channels`-Zeile (type `chat`, `config: { widget: true, public_token, theme }`). Das Theme wird im Designer bearbeitet (siehe „Design“ unten); das Widget lädt es via `POST /api/widget/bootstrap`.
- **Session-Modell:** Erst beim ersten Absenden entsteht serverseitig contact → conversation (`mode: bot`) → `widget_sessions`-Zeile (Migration 0003). Das Session-Secret (48 hex) verlässt den Server genau einmal; gespeichert wird nur der SHA-256-Hash. Das Widget hält `{ conversationId, secret }` in `localStorage` und resumed damit (History-Reload). Ungültiges Resume → `{ expired: true }`, das Widget startet als Erstbesucher — es entstehen keine Junk-Zeilen.
- **Realtime beidseitig:** Besucher→Agent über den bestehenden Inbox-Refresher (postgres_changes). Agent→Besucher über einen DB-Trigger (0003): jede OUT-Message wird per `realtime.send` an den unerratbaren `broadcast_topic` (48 hex) der Session gesendet; das Widget subscribed mit dem Anon-Key (RealtimeClient, public Topic — Zugriffsschutz ist die Topic-Entropie).
- **Kontaktdaten-Abfrage:** optional und überspringbar; aktualisiert ausschließlich den EIGENEN Kontakt der Session. Bewusst KEIN Merge auf bestehende Kontakte per E-Mail-Behauptung (Contact-Hijack-Schutz) — Dubletten löst später die KI-Extraktion (Phase 4) bzw. der Agent.
- **Offline-Verhalten:** Banner bei Verbindungsverlust, Sende-Retry mit Backoff (gleiche `clientMessageId` → serverseitige Dedupe über `external_id = widget-<clientMessageId>`), Resubscribe + History-Nachladen beim `online`-Event. Eingehende Nachricht auf `resolved`-Konversation öffnet sie wieder (`open`).

## Öffentliche Routen (`/api/widget/*`, CORS `*`)

| Route             | Zweck                     | Limit (pro Minute)          |
| ----------------- | ------------------------- | --------------------------- |
| `POST /bootstrap` | Theme + Realtime-Config   | 30 / IP                     |
| `POST /session`   | Session anlegen / resumen | 10 / IP                     |
| `POST /message`   | Nachricht / Kontaktdaten  | 30 / IP + 15 / Konversation |

- **Rate-Limit:** Upstash Ratelimit (User-Entscheidung §12; EU-Region). Env `UPSTASH_REDIS_REST_URL/TOKEN`; fehlen sie, läuft es **fail-open** (eine Warnung im Log) — in Production immer konfigurieren. Client-IP: `x-real-ip`, sonst letzter `x-forwarded-for`-Eintrag (der linkeste ist spoofbar), sonst gemeinsamer `unknown`-Bucket.
- Auth-Kette pro Request: public_token → Channel (aktiv, widget) → Org; für Schreibzugriffe zusätzlich Secret-Hash-Vergleich. Alle Admin-Client-Writes tragen redundante `org_id`-Guards (Defense-in-Depth). DB-Fehler → 503 (Session bleibt clientseitig erhalten), unbekannt/ungültig → 404/401.
- Die Auth-Middleware lässt `/widget.js` und `/api/widget/*` explizit durch (Routen machen eigene Auth).

## Design (seit 2026-11-20)

Das Widget hat ein neues Aussehen und ein erweitertes Theme. **Keine Migration:** Das Theme liegt
weiter als JSON in `channels.config.theme`.

**Ein Modell für drei Stellen:** `packages/channels/src/chat/theme.ts` (ohne Abhängigkeiten, damit
es ins Widget-Bundle passt) wird vom Widget, vom Server und vom Designer benutzt. `normalizeWidgetTheme`
macht aus allem ein vollständiges, sicheres Theme: fehlende Felder bekommen Standardwerte, alte
Themes mit nur Farbe/Titel/Begrüßung funktionieren unverändert weiter, ungültige Werte fallen auf den
Standard zurück. Das Widget vertraut der gespeicherten Form nie.

| Bereich | Optionen |
| --- | --- |
| Texte | Titel, Untertitel (mit Online-Punkt), Begrüßung, Platzhalter, bis zu 4 Schnellantworten |
| Farben | Hauptfarbe, Verlauf mit zweiter Farbe, Fenster hell / dunkel / automatisch |
| Schrift | Systemschrift, Schrift der Website, Inter, Sora, Serif, eigene Schrift (Name); Größe klein / normal / groß |
| Form | Ecken eckig / weich / rund, Position links / rechts, Abstand zum Rand |
| Chat-Button | nur Symbol oder Symbol mit Text, fünf Symbole, Hinweis-Sprechblase (Teaser) |
| Kopfzeile | Avatar: keiner, Symbol, Initialen oder Logo (https-Adresse) |
| Sonstiges | „Bereitgestellt von Zendori“ |

Dazu sechs Vorlagen (Zendori, Indigo, Mitternacht, Koralle, Wald, Schlicht), die nur das Aussehen
setzen und die Texte lassen.

Regeln:

- **Schriftfarbe auf der Hauptfarbe** wählt das Widget selbst (weiß oder fast schwarz, nach
  Kontrast; bei einem Verlauf entscheidet das schwächere Ende).
- **Schriften:** Inter und Sora liefert Zendori selbst aus (`public/widget-fonts`, CORS offen,
  über die FontFace-API geladen) — kein fremder Schriften-Dienst, die IP des Besuchers geht nur an
  die Zendori-App. „Schrift der Website“ erbt die Schrift der Kundenseite, „Eigene Schrift“ nennt
  eine Schrift, die die Kundenseite selbst lädt.
- **Logo:** nur `https://`-Adressen; ein kaputtes Bild fällt auf das Symbol zurück. Ein Upload ist
  nicht gebaut.
- **Teaser:** erscheint 4 s nach dem Laden, einmal pro Browser, nicht für Besucher mit laufendem Chat.
- **Schnellantworten** stehen unter der Begrüßung, bis die erste echte Nachricht da ist. Ein Klick
  sendet den Text als normale Nachricht.
- Alle Theme-Texte laufen über `textContent`, Symbole sind fest im Code — ein Theme kann kein
  Markup einschleusen. Schriftname und Logo-Adresse werden zusätzlich bereinigt.

**Designer:** Kanäle → Chat-Kanal → Tab „Design“ (`components/WidgetDesigner.tsx`). Links die
Optionen, rechts das **echte Widget** in einer Vorschau (derselbe Code wie auf der Kundenseite,
`createWidgetUi` im Vorschau-Modus) mit den Ansichten Start, Gespräch und Geschlossen. Speichern
über `updateWidgetTheme` (zod-Prüfung, danach `normalizeWidgetTheme`).

**Kompatibilität:** Ein altes, im Browser gecachtes `widget.js` liest aus der Bootstrap-Antwort nur
Farbe, Titel und Begrüßung und läuft weiter. Bestehende Kanäle bekommen das neue Aussehen mit ihrer
bisherigen Farbe, ohne dass jemand speichern muss.

## Build

`apps/web/src/widget/*.ts` → esbuild (`scripts/build-embeds.mjs`) → `public/widget.js` (~95 kB minified, IIFE, kein Framework). Läuft automatisch via `predev`/`prebuild`; das Artefakt ist gitignored.

## Manueller Test

1. Einstellungen → Kanäle → „Chat-Widget anlegen" → Theme (Farbe/Titel/Begrüßung) speichern.
2. Kanal öffnen → Reiter **Test** (seit 2026-11-27, docs/webchat-test.md; die frühere Seite
   „Widget-Demo“ leitet dorthin): Das Chat-Fenster erscheint im Theme.
3. Nachricht senden → erscheint in der Inbox (zweiter Tab: live).
4. In der Inbox antworten → Antwort erscheint im Widget **ohne Reload**.
5. Kontaktdaten-Block im Widget ausfüllen → Kontakt in der Inbox-Sidebar aktualisiert.
6. Seite neu laden → Verlauf ist wieder da (Resume).
7. Konversation auf „Gelöst" setzen, im Widget erneut schreiben → Konversation steht wieder auf „Offen".

### Design (2026-11-20)

8. Kanäle → Chat-Kanal → Tab **Design**. **Erwartet:** links die Optionen, rechts die Vorschau mit
   dem Widget im bisherigen Farbton.
9. Vorlage „Zendori“ anklicken. **Erwartet:** Die Vorschau wechselt sofort auf den grün-blauen
   Verlauf; Titel und Begrüßung bleiben.
10. Untertitel und zwei Schnellantworten eintragen, Schrift „Sora“, Ecken „Rund“. **Erwartet:** Alles
    erscheint sofort in der Vorschau. In der Vorschau lässt sich schreiben, ohne dass etwas gesendet wird.
11. „Hinweis neben dem Button“ einschalten. **Erwartet:** Die Vorschau springt auf „Geschlossen“ und
    zeigt die Sprechblase neben dem Chat-Button.
12. „Design speichern“. **Erwartet:** Meldung „Design gespeichert.“; nach dem Neuladen stehen alle Werte noch da.
13. Reiter **Test** öffnen (früher „Widget-Demo“). **Erwartet:** Das Widget erscheint im gespeicherten
    Design, der Chat ist dort schon geöffnet. Den Hinweis neben dem Button (nach etwa 4 s, einmal
    pro Browser) sieht man auf der eigenen Website mit dem Embed-Code. Ein Klick auf eine Schnellantwort
    sendet sie als Nachricht in die Inbox.
14. Fenster auf Handybreite ziehen und den Chat öffnen. **Erwartet:** Der Chat füllt den ganzen
    Bildschirm, geschlossen wird über den Pfeil oben rechts.
15. Fenster „Automatisch“ wählen und das System auf Dunkel stellen. **Erwartet:** dunkles Chat-Fenster.

Geprüft am 2026-11-20 (lokal gegen das echte Projekt, Wegwerf-Organisation, danach gelöscht):
Schritte 8 bis 12 und 14, das echte Widget über Bootstrap mit Teaser und Schnellantworten, dazu
eine Galerie aller Vorlagen. **Nicht geprüft:** das Senden einer Schnellantwort bis in die Inbox
(Schritt 13, bewusst keine Nachricht erzeugt) und Schritt 15 im echten Widget.
