# Konzept: Formular-Builder (Phase 10)

Stand: 2026-07-21. Status: **konzipiert, noch nicht gebaut** — Start nach
Abschluss der Voice-/WhatsApp-Stabilisierung (Entscheidung PO 2026-07-21).
Erarbeitet aus drei Teilkonzepten + adversarialem Review (11 Findings, alle
unten eingearbeitet). Bei Implementierungsstart: CLAUDE.md-Änderungen aus §1
umsetzen und dieses Dokument zur Phase-Doku machen.

## 0. Zielbild

Ein Kunde legt in Zendori ein Formular an (Builder), bekommt einen Embed-Code
für beliebige Websites, verknüpft es über den Channel-Mechanismus
(`channels.agent_id`) mit einem Agenten und hinterlegt optional 1–10
E-Mail-Adressen, an die jede Einsendung als gestaltetes HTML-Mail
weitergeleitet wird. Jede Einsendung wird eine normale Conversation + Message
(`processing_state='pending'`) und läuft durch die bestehende Worker-Pipeline.
Der bisherige No-Code-Weg (fremdes Formular sendet an eine Inbound-Adresse)
bleibt parallel bestehen — Kachel wird zu **„Formular-Weiterleitung"**
umbenannt, die neue heißt **„Web-Formular"**.

## 1. CLAUDE.md-Änderungen (bei Implementierungsstart)

1. **§2 Nicht-Ziele:** „Kein separater Form-POST-Endpoint …" ersetzen durch:
   „Formular-Intake hat genau zwei Wege: (a) Inbound-E-Mail-Adressen (No-Code,
   Bestand) und (b) der Zendori-Formular-Builder mit eigenem öffentlichen
   Submission-Endpoint (`/api/forms/*`). Kein dritter Weg, keine generischen
   Webhook-Intakes."
2. **§1/§3/§4/§5:** Feature-Bullet, Stack-Bullet (Embed via Shadow DOM +
   gehostete Seite `/f/{token}`), „Form-Submit" im Nachrichtenfluss, Tabellen
   `forms` + `form_notifications` im Datenmodell.
3. **§11:** „Phase 10 — Formular-Builder" mit STOP.
4. **§13:** keine neuen Env-Variablen (Resend/Upstash/`MASTER_ENCRYPTION_KEY`
   vorhanden; Render-Token-Key per HKDF abgeleitet).

## 2. Verbindliche Architektur-Entscheidungen

(Konflikte der Teilkonzepte aufgelöst — Datenmodell/API-Teil ist Quelle der
Wahrheit, UI-Teil liefert nur Builder/Renderer/Embed.)

| # | Entscheidung | Begründung |
|---|---|---|
| 1 | **Kein neuer `channels.type`** — Wiederverwendung `type='email'`, `mode='inbound'`, `purpose='form'`, plus Flag `config.builderForm: true` | Antwortpfad (`deliverOutboundEmail`), E-Mail-Threading eingehender Antworten (Resend-Hook), Extract-Gate im Worker und Quota-Kind `form` funktionieren ohne Umbau. Jeder Builder-Channel behält eine generierte Intake-Adresse als Fallback/Anker. |
| 2 | **Formular-Definition in eigener Tabelle `forms`** (1:1 Channel, `definition jsonb`, `version int`, `public_token` unique, `notification_emails jsonb`), NICHT in `channels.config` | Indexgestütztes Token-Lookup statt jsonb-contains; Quota-Trigger evaluiert config bei jedem Write; Schema-Drift-Präzedenzfall (Widget) nicht wiederholen. Submissions speichern einen Feld-Snapshot in `messages.metadata.form` ⇒ keine `form_versions`-Tabelle in v1 nötig. |
| 3 | **Kontingent: gemeinsames Kind `form`** für E-Mail-Intake UND Builder-Formulare (Entscheidung PO 2026-07-21) | „N Formulare" pro Kunde, egal welcher Mechanik. `private.channel_kind` (0017) und `channelKindOf` bleiben UNANGETASTET; nur `checkChannelQuota(org,'form')` in der Anlage-Action. Admin-Kommunikation: das Limit deckelt künftig beide. |
| 4 | **Routen `/api/forms/bootstrap` + `/api/forms/submit`** (CORS wie Widget), Submission-Payload `{ token, clientSubmissionId, renderToken, values, website }` | HMAC-`renderToken` (Key per HKDF aus `MASTER_ENCRYPTION_KEY`, `issuedAt` 3 s–24 h) statt eines client-gelieferten Timestamps — nicht fälschbar. `website` = Honeypot (muss leer sein, sonst silent discard). |
| 5 | **Feldmodell mit `role`-Konzept** (`name\|email\|phone\|subject\|message`), Keys `^[a-z0-9_]{1,40}$`, Typen v1: text, email, phone, textarea, select, radio, checkbox, date, hidden, **consent** | Contact wird DIREKT aus den role-Feldern gesetzt (find-or-create per E-Mail, `metadata.form.contact_authoritative=true` ⇒ `correctContact` überspringt KI-Überschreiben). Builder erzwingt per Default genau ein `role='email'`-Feld und ein `consent`-Feld (Abwahl nur mit Warnhinweis). |
| 6 | **`external_id = 'form-' + clientSubmissionId`** | Idempotenz über bestehenden Unique-Index `(channel_id, external_id)`; 23505 ⇒ dedupe + Conversation-Rollback (Resend-Routen-Muster). |
| 7 | **Immer neue Conversation pro Einsendung** | Formulare sind Einmal-Anliegen; Mail-Antworten des Einsenders threaden über den Resend-Hook hinein. |
| 8 | **Weiterleitungs-Mail aus dem Worker** (neue Tabelle `form_notifications` state=pending → Scan-Schritt → pg-boss-Queue `form.notify`), EIN Resend-Send an ≤10 Empfänger, Reply-To = Einsender | §12-Rollenteilung (kein Versand/pg-boss in Vercel), Retries über pg-boss; Fehler ⇒ `state='failed'` + interne Notiz **inkl. Resend-Fehlermeldung** (Owner findet die kaputte Adresse). `notification_emails` beim Speichern strikt `z.email()`-validiert. Trade-off dokumentieren: Direkt-Antworten der Empfänger laufen an Zendori vorbei. Per-Empfänger-Versand + Bounce-Auswertung (`email.bounced` am Svix-Hook) = Ausbaustufe. |
| 9 | **Keine Datei-Uploads in v1** | Öffentlicher Upload = eigener Missbrauchs-/Kostenvektor; Attachment-Infra liegt als Blaupause bereit (v2). |
| 10 | **Kein CAPTCHA in v1** | Honeypot + HMAC-Min-Time + Upstash-Rate-Limits (IP 5/min, Token 30/min) + strikte Server-Validierung gegen die Definition; keine neuen US-Processor (§7). Eskalationsstufe bei realem Missbrauch. |

## 3. Sicherheits-Findings aus dem Review (verbindlich einzubauen)

1. **Spam-Relay über den Auto-Send-Pfad (Blocker):** Angreifer trägt fremde
   E-Mail ein ⇒ Autopilot-Antwort geht von der Kundendomain an das Opfer;
   Zendori-Intake-Adressen als „Einsender" könnten Mail-Loops erzeugen.
   Maßnahmen: (a) Outbound-Suppression in `deliverOutboundEmail` und
   `form.notify` für Empfänger unter `INBOUND_EMAIL_DOMAIN`; (b) Formular-
   Channels defaulten auf draft_only — Autopilot nur mit explizitem
   Warnhinweis im Builder; (c) bei find-or-create-Treffer auf bestehenden
   Contact keinen Namens-Overwrite.
2. **KI-Kosten-DoS (Major):** Rate-Limits sind fail-open. Zusätzlich ein
   DB-basierter Tages-Cap pro Formular (Owner-konfigurierbar, Default z. B.
   200/Tag) VOR dem Persist; bei `metadata.form`-Snapshot den **extract-Schritt
   überspringen** (Daten sind strukturiert — spart einen Haiku-Call pro
   Einsendung).
3. **DSGVO-Consent (Major):** `consent`-Feldtyp mit Text-Snapshot +
   `accepted_at` in `metadata.form.consent`, `privacyPolicyUrl` pro Formular;
   Submit erzwingt `consent===true` serverseitig. Keine IP-Speicherung.
   Gehostete Seite `/f/{token}`: Datenschutz-Link Pflichtfeld vor Rollout.
4. **RLS = Wahrheit (Minor):** `forms` select/insert/update member-verwaltet
   (wie `knowledge_bases`), **delete owner-only per RLS**;
   `notification_emails`-Änderung owner-only per Trigger (PII-Abfluss-Risiko);
   Kopplung „forms nur an Channels mit `config.builderForm=true`" per
   Trigger/Check absichern. Anlage Channel+Form über Aufräumpfad (oder RPC)
   gegen halbe Zustände.
5. **renderToken-Ablauf (Minor):** eigener Fehlercode; Embed re-bootstrapped
   transparent (neues Token, Submit wiederholen, Eingaben bleiben). Auch
   `/f/[token]` ruft clientseitig bootstrap auf.
6. **`org.purge`-Checkliste:** `forms` + `form_notifications` aufnehmen (der
   Purge-Job existiert noch nicht; nicht auf Org-Delete-Kaskade verlassen).
7. **HTML-Escaping** der Feldwerte im Mail-Template ist Pflicht (+Test) —
   sonst Content-Injection/Phishing-Optik.
8. **`BARE_PREFIXES`:** `'/f/'` (mit Slash) eintragen — `'/f'` würde jede
   künftige `/f*`-Route chromelos rendern.

## 4. Builder-UI (v1)

- **Navigation:** neuer Punkt „Formulare"; Routen `/settings/forms` (Liste +
  Anlegen), `/settings/forms/[channelId]` (Builder, volle Breite),
  `/f/[token]` (gehostete Seite, bare). Kanäle-Galerie: schlanke Kachel
  „Web-Formular" nur mit AgentSelect/ActiveToggle + Link in den Builder.
- **Interaktionsmodell:** vertikale Feld-Karten mit ↑/↓ + Inline-Accordion-
  Editor (kein Drag&Drop, keine Dependency; natives HTML-DnD als v2 on top).
  Feld-IDs stabil generiert, key-Regex-konform, nie aus dem Label.
- **Tabs Felder | Design | Einbetten.** Design v1: Primärfarbe mit
  WCAG-Kontrast-Check (Buttontext auto schwarz/weiß), Radius-Preset
  (eckig/rund/pill), Button-Text, Titel/Intro, Erfolgsmeldung. Kein Logo (v2).
- **Live-Vorschau = derselbe framework-freie Renderer** wie `form.js` und
  `/f/[token]` (`apps/web/src/form-embed/render.ts`, Shadow-Root,
  `mode:'preview'`) — WYSIWYG ohne Drift. Umschalter Desktop/Mobil +
  Formular/Erfolgsansicht.
- **Speichern-Modell:** explizites Speichern mit sofortiger Live-Wirkung,
  Unsaved-Hinweis + `beforeunload`-Guard (Draft/Publish = v2).
- **Embed:** Platzhalter-`div data-zendori-form="TOKEN"` + `<script
  src="…/form.js" async>` (Shadow DOM, mehrere Formulare pro Seite,
  Bundle < 15 kB, Build via generalisiertem `build-embeds.mjs`); gehosteter
  Link als Test-Ziel/QR/CMS-Fallback; iframe nur als dokumentierter Fallback
  (Auto-Resize = v2).
- **A11y-Basics verbindlich:** label/for, aria-invalid + describedby,
  aria-live-Fehlerzusammenfassung, `role="status"`-Erfolg, native Controls,
  :focus-visible-Ringe.
- **Mehrsprachigkeit v1:** alle Strings sind Org-Content (deutsche Defaults),
  drei überschreibbare Systemtexte; mehrere Sprachen = Formular duplizieren.

## 5. Migration `0019_forms.sql` (Skizze)

`channels` bekommt `unique (id, org_id)` (Composite-FK-Ziel, Muster 0011);
`forms` (org_id, channel_id 1:1 unique + Composite-FK, name, public_token
unique, definition jsonb, version, notification_emails jsonb, is_active) mit
RLS wie §3.4; `form_notifications` (message_id unique, recipients-Snapshot,
state pending|sent|failed, attempts, partieller pending-Index) — Writes nur
Service Role, select member. RLS-Tests für beide (DoD §14).

## 6. v2-Ausbaustufen

Datei-Upload (Signed-URL-Flow), Logo/Font/Dark-Variante, radio→Multi-Select-
Ausbau, Redirect-URL (Allowlist), iframe-Auto-Resize, Locale-Varianten,
Draft/Publish-Versionierung, bedingte Logik/Mehrschritt, Einsendungs-Statistik,
per-Empfänger-Zustellstatus + Bounce-Auswertung, Turnstile/CAPTCHA-Eskalation.
