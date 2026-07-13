# Phase 2 — Chat-Widget

Stand: 2026-07-13. Embeddables Chat-Widget mit anonymen Sessions, Realtime in beide Richtungen und Theming pro Org.

## Einbindung (Kundenseite)

Ein Script-Tag, kein weiterer Code:

```html
<script src="https://<APP_URL>/widget.js" data-zendori-token="<PUBLIC_TOKEN>" async></script>
```

Das Snippet (inkl. Token) steht unter **Einstellungen → Kanäle** am jeweiligen Widget-Channel. Der Token ist öffentlich — er identifiziert nur den Kanal, autorisiert aber nichts über die Session hinaus. Optional: `data-zendori-url`, falls die API nicht am Script-Origin liegt.

## Architektur

- **Widget-Channel** = `channels`-Zeile (type `chat`, `config: { widget: true, public_token, theme: { color, title, greeting } }`). Theme im UI editierbar; das Widget lädt es via `POST /api/widget/bootstrap`.
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

## Build

`apps/web/src/widget/*.ts` → esbuild (`scripts/build-widget.mjs`) → `public/widget.js` (~74 kB minified, IIFE, kein Framework). Läuft automatisch via `predev`/`prebuild`; das Artefakt ist gitignored.

## Manueller Test

1. Einstellungen → Kanäle → „Chat-Widget anlegen" → Theme (Farbe/Titel/Begrüßung) speichern.
2. Navigation → **Widget-Demo**: Bubble unten rechts erscheint im Theme.
3. Nachricht senden → erscheint in der Inbox (zweiter Tab: live).
4. In der Inbox antworten → Antwort erscheint im Widget **ohne Reload**.
5. Kontaktdaten-Block im Widget ausfüllen → Kontakt in der Inbox-Sidebar aktualisiert.
6. Seite neu laden → Verlauf ist wieder da (Resume).
7. Konversation auf „Gelöst" setzen, im Widget erneut schreiben → Konversation steht wieder auf „Offen".
