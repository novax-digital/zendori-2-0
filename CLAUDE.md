# CLAUDE.md — Zendori v2 (Clean Rebuild)

## 1. Mission

Zendori v2 ist eine eigenständige, mandantenfähige Multichannel-Kundensupport-Plattform.
Kein Chatwoot, kein Fremd-Helpdesk — alles eigene Lösung. Ziel aller Kanäle ist immer die eigene Shared Inbox.

Kern-Features:
- **Kanäle:** Website-Chat-Widget, E-Mail (Inbound-Adressen als universeller Intake + später angebundene Postfächer), WhatsApp, Telefon (Voice, letzte Phase)
- **Universeller Formular-Intake:** Kontaktformulare beliebiger Websites senden einfach an eine generierte Zendori-Inbound-Adresse (Empfänger oder CC) — kein Code auf der Kundenseite nötig
- **Shared Inbox:** ein Posteingang für alle Kanäle, Team-Zuweisung, interne Notizen, Status
- **Wissensdatenbank:** pro Kunde (Org), Quellen: URL-Crawl, Dateien, manuelle Texte → RAG
- **KI-Agent:** klassifiziert, extrahiert (Ticketisierung), beantwortet mit RAG, Confidence-Gate
- **Human Handoff:** Bot → Mensch nahtlos, Mensch → Bot zurück
- **Mandantenfähig:** jeder Zendori-Kunde = eine Organization, strikt getrennt (RLS)
- **Integrationen:** optionaler HubSpot-Ticket-Sync mit Regeln pro Org/Kanal (Ablösung der bestehenden Zendori-Bridge)

## 2. Nicht-Ziele

- Kein Chatwoot, keine Chatwoot-Kompatibilität.
- Kein n8n im Kernpfad. Die alten n8n-Workflows sind nur **Referenz/Spezifikation** (siehe §10).
- Kein separater Form-POST-Endpoint. Formular-Intake läuft ausschließlich über Inbound-E-Mail-Adressen (§3).
- HubSpot ist nie Kern-Abhängigkeit — nur optionale, pro Org abschaltbare Integration.
- Kein Kubernetes, keine Microservices, kein Event-Sourcing. Ein Monorepo, zwei Prozesse.
- Keine Features außerhalb der aktuellen Phase. Keine „wo wir schon dabei sind"-Erweiterungen.

## 3. Stack (fix — nicht austauschen, nicht diskutieren)

- pnpm Monorepo, TypeScript `strict`, Node 22 LTS
- **Next.js 15** (App Router): Inbox-UI, Settings, Widget, Webhook-/API-Endpoints
- **Supabase (EU):** Postgres + pgvector, Auth, Realtime, Storage. RLS auf jeder Tabelle.
- **pg-boss** für Jobs/Queues im Worker-Prozess.
  ⚠️ pg-boss braucht eine **Session-Mode-Verbindung** (direkter Port bzw. Session-Pooler), NICHT den Transaction-Pooler.
- **KI:** Anthropic API — `claude-haiku-4-5` für Klassifikation/Extraktion, `claude-sonnet-4-6` für Antwort-Drafts. Embeddings: OpenAI `text-embedding-3-small` (1536 dim).
- **E-Mail (Standard-Weg): Resend.**
  - Inbound: eigene Receiving-Subdomain (z. B. `in.zendori.de`, MX → Resend). ⚠️ NIEMALS die Root-Domain als Receiving-Domain — sonst landet der komplette normale Mailverkehr bei Resend.
  - Catch-all: jede Adresse `*@in.zendori.de` trifft denselben `email.received`-Webhook; Routing über das `to`-Feld → Channel-Lookup.
  - Pro Intake-Quelle eine **generierte, nicht erratbare Adresse** (z. B. `strongenergy-kf-x7k2m9@in.zendori.de`) = ein Channel mit sprechendem Namen in der Inbox.
  - Versand über die Resend-API (verifizierte Kundendomain, sonst Zendori-Absender mit Reply-To auf die Intake-Adresse).
  - Komplett serverless — läuft ohne Worker in apps/web.
- **E-Mail (optional, Phase 8): IMAP/SMTP** für Kunden, die ihr bestehendes Postfach direkt anbinden wollen (ImapFlow + Nodemailer im Worker, Credentials verschlüsselt).
- **WhatsApp:** Meta WhatsApp Cloud API direkt (Webhooks + Graph API). Kein BSP, kein Twilio.
- **Chat:** eigenes Embeddable Widget (ein Script-Tag) + Supabase Realtime.
- **HubSpot (optional, Phase 6):** einseitiger Ticket-Sync pro Org mit Sync-Regeln (alle Konversationen | nur ausgewählte Kanäle | nur manuell). Kein Kern-Bestandteil.
- **Voice (Phase 9):** Provider-Entscheidung offen (xAI Grok Voice vs. ElevenLabs Agents). NICHT vorab implementieren. Integration ist provider-agnostisch über Zendori-Tool-Endpoints (§9).
- **Deployment:** apps/web → **Vercel** (Region `fra1`), apps/worker → Docker-Container auf dem bestehenden Hetzner VPS (Details §12).
- Validierung: `zod` überall an Systemgrenzen. Tests: `vitest`. Logging: `pino`.

## 4. Monorepo-Layout

```
apps/web        → Next.js: Inbox, Settings, Widget-Host, Webhooks (/api/hooks/*), Resend-Ingest
apps/worker     → Node-Prozess: pg-boss Worker (KI-Pipeline, Crawler, HubSpot-Sync, ab Phase 8 IMAP)
packages/core   → Domain-Typen, zod-Schemas, DB-Client, Verschlüsselung
packages/channels → Adapter: chat | email | whatsapp | voice (ein Interface)
packages/ai     → Klassifikation, Extraktion/Ticketisierung, RAG, Draft, Confidence
supabase/       → Migrations (supabase CLI), Seed
docs/           → Architektur-Notizen, legacy-analysis.md, Testanleitungen
old-app/        → alte Zendori-App aus Lovable (READ-ONLY, nur Referenz)
old-n8n-flows/  → n8n-Workflow-JSONs (READ-ONLY, nur Referenz)
old-bridge/     → Zendori-Bridge: Formular/E-Mail → KI → HubSpot (READ-ONLY, nur Referenz)
```

### Channel-Adapter-Interface (verbindlich)

```ts
interface ChannelAdapter {
  type: 'chat' | 'email' | 'whatsapp' | 'voice';
  // Webhook/Ingest-Payload → normalisierte Nachricht
  normalize(raw: unknown): UnifiedInboundMessage;
  // Antwort aus der Inbox / vom Bot rausschicken
  send(msg: OutboundMessage, channelConfig: ChannelConfig): Promise<SendResult>;
}
```

### Nachrichtenfluss (gilt für ALLE Kanäle)

```
Kanal-Webhook (Resend / WhatsApp / Widget / Voice, später IMAP)
→ normalize → Conversation-Resolver (Threading + Dedupe via external_id)
→ persist (messages) → Realtime-Event an Inbox
→ wenn conversation.mode = 'bot': KI-Pipeline (classify+extract → retrieve → draft → confidence)
   → confidence ≥ threshold UND Autopilot an: auto-send (sender_type='bot')
   → sonst: suggested_reply speichern + ggf. Handoff (§6)
→ wenn mode = 'human': nur persist + notify, Bot schweigt
→ danach: HubSpot-Sync-Job, falls Regeln der Org greifen (§ Phase 6)
```

**Rollenteilung (wichtig wegen Vercel):** apps/web schreibt nur Domain-Daten (persist + Realtime-Event) und macht nichts Langlaufendes. apps/worker holt sich Arbeit selbst: pg-boss-Poll im Sekundentakt über eingehende Nachrichten mit `processing_state = 'pending'`. Kein Job-Enqueue aus Vercel-Functions, keine pg-boss-Imports in apps/web.

## 5. Datenmodell (Kern)

Alle Tabellen mit `org_id`, `created_at`, RLS. `external_id` unique pro Channel (Idempotenz).

- `organizations` (Zendori-Kunden), `org_members` (user_id, role: owner|agent)
- `channels` (org_id, type: chat|email|whatsapp|voice, name, config jsonb, is_active)
  - email-Channel: `config.mode: 'inbound' | 'imap'`; bei inbound: `config.address` (die generierte Adresse), bei imap: verschlüsselte Credentials (§7)
- `integrations` (org_id, type: hubspot, config jsonb — Token verschlüsselt wie §7, rules jsonb — Sync-Regeln: all | channel_ids[] | manual, is_active, last_sync_at)
- `contacts` (org_id, name, email, phone, wa_id, external_ids jsonb) — Identitäten mergen, wenn E-Mail/Telefon übereinstimmt; bei Formular-Mails wird der echte Kontakt per KI-Extraktion gesetzt (Phase 4), nicht der Envelope-Absender
- `conversations` (org_id, channel_id, contact_id, subject, status: open|pending|resolved, **mode: bot|human**, assignee_id, priority, last_message_at, external_refs jsonb — z. B. hubspot_ticket_id)
- `messages` (conversation_id, direction: in|out, sender_type: contact|agent|bot|system, content, content_type: text|html|audio|image|file, external_id, metadata jsonb, processing_state: pending|done|skipped — nur für direction=in relevant, Basis für den Worker-Poll)
- `attachments` (message_id, storage_path, mime, size)
- `notes` (conversation_id, author_id, content) — intern, nie an Kunden
- `canned_responses` (org_id, shortcut, content)
- `kb_sources` (org_id, type: url|file|text, uri, status: pending|indexed|error, last_indexed_at)
- `kb_chunks` (source_id, org_id, content, embedding vector(1536), token_count)
- `ai_runs` (conversation_id, step, model, input_summary, output_summary, confidence, latency_ms, cost_usd)
- `handoff_events` (conversation_id, reason: low_confidence|user_request|keyword|manual, triggered_by)
- `org_settings` (org_id, autopilot_enabled per channel, confidence_threshold default 0.7, tone_instructions, business_hours, auto_ack_texts)

## 6. Human-Handoff-Logik (verbindlich)

Default: `mode = 'bot'`. Handoff-Trigger:
1. `confidence < threshold` (org-konfigurierbar)
2. Kunde verlangt explizit einen Menschen (Klassifikations-Flag)
3. Eskalations-Keywords (Kündigung, Beschwerde, Anwalt, Datenschutz — org-konfigurierbar)
4. Agent klickt „Übernehmen" in der Inbox

Bei Handoff: `mode = 'human'`, `status = 'pending'`, `handoff_events`-Eintrag, Realtime-Notification, optional Auto-Ack an den Kunden („Ein Mitarbeiter übernimmt…", pro Org konfigurierbar, außerhalb Geschäftszeiten anderer Text).
Agent kann per Klick an den Bot zurückgeben (`mode = 'bot'`).
Solange `mode = 'human'`: Bot generiert **keine** Antworten, auch keine Drafts, außer Agent fordert explizit einen Draft an.

## 7. Sicherheit & DSGVO (nicht verhandelbar)

- Alle Daten in EU (Supabase EU, Hetzner). Keine US-Datenverarbeitung ohne explizite Freigabe von mir.
  - **Bewusste, freigegebene Ausnahme: Resend** als E-Mail-Provider (bereits im Einsatz). Vor Kunden-Rollout: AVV/SCCs und Speicherorte prüfen — Aufgabe von mir, im Code nichts weiter nötig.
- Secrets nur via `.env` / Server-Env. Nie ins Repo. `.env.example` immer aktuell halten.
- Kanal- und Integrations-Credentials (IMAP/SMTP-Passwörter, WhatsApp-Tokens, HubSpot-Token) verschlüsselt in `channels.config` bzw. `integrations.config`: libsodium secretbox mit `MASTER_ENCRYPTION_KEY` aus Env. Nie im Klartext loggen oder an den Client geben.
- Webhooks verifizieren: Resend per Svix-Signatur (`resend.webhooks.verify`, Raw Body!), WhatsApp per `X-Hub-Signature-256` (App Secret), Widget-Requests mit org-gebundenem Public Token + Rate Limit. Unbekannte Inbound-Adressen: loggen (nur Metadaten) und verwerfen.
- RLS: Zugriff nur über `org_members`. Worker nutzt Service Role. Jede neue Tabelle bekommt einen RLS-Test.
- Keine Nachrichteninhalte in Logs (pino redact). Request-IDs ja, Content nein.
- Löschkonzept: Konversationen, Kontakte, KB inkl. Embeddings pro Org vollständig löschbar (Job `org.purge`).

## 8. Arbeitsregeln für dich (Claude Code)

1. **Strikt phasenweise arbeiten (§11).** Am Ende jeder Phase: **STOP** — Zusammenfassung, was gebaut wurde, manuelle Testanleitung Schritt für Schritt, offene Punkte. Dann auf mein „weiter" warten.
2. Vor jeder Migration und jedem destruktiven Schritt: Plan + Diff zeigen, **Freigabe abwarten**. `supabase db push` nie ohne mein OK.
3. Keine ungefragten Refactorings. Keine neuen Dependencies ohne Ein-Satz-Begründung.
4. Jede externe API hinter dem Adapter-Interface + zod-Parsing der Payloads. Kein `any` an Systemgrenzen.
5. Webhooks idempotent (external_id-Check vor Insert). Retries über pg-boss, nicht selbstgebaut.
6. Nach jeder Phase müssen `pnpm typecheck && pnpm lint && pnpm test` grün sein.
7. UI-Texte Deutsch, Code/Kommentare Englisch.
8. Wenn etwas im Legacy-Code unklar ist: fragen, nicht raten.
9. Bei Fehlern in Produktion/Deploy: erst Diagnose + Ursache erklären, dann Fix vorschlagen, dann umsetzen.

## 9. Voice-Integration (Vorgabe für Phase 9, provider-agnostisch)

Der Voice-Provider (xAI oder ElevenLabs — Entscheidung fällt mit mir per Testanruf vor Phasenstart) läuft extern und spricht mit Zendori über drei Endpoints:

- `POST /api/voice/tools/kb-search` → { query } → Top-KB-Chunks der Org (gleiche RAG-Funktion wie Text-Pipeline)
- `POST /api/voice/tools/handoff` → { reason } → Handoff + Rückruf-Ticket, optional Live-Transfer-Nummer zurückgeben
- `POST /api/hooks/voice` → Call-Events + Transkript → Conversation (channel=voice), Transkript-Turns als `messages`, Audio-Recording in Storage

Auth: pro Org ein Voice-API-Key (Header), Requests zod-validiert. Kontakt-Matching über Anrufernummer.
Damit bleibt der Kern identisch: Anrufe erscheinen als ganz normale Konversationen in der Inbox.

## 10. Legacy-Import (Teil von Phase 0)

Drei Referenz-Ordner im Repo, alle READ-ONLY, nie direkt importieren:
- `old-app/` — alte Zendori-App (Lovable)
- `old-n8n-flows/` — n8n-Workflow-JSONs
- `old-bridge/` — Zendori-Bridge (Kontaktformular + E-Mail → KI-Ticketisierung → HubSpot), **läuft aktuell produktiv für einen Bestandskunden**. Der hardcodierte Formular-Pfad in der Strong-Energy-Website wird in v2 durch eine Inbound-Adresse ersetzt (Formular-Empfänger umstellen).

Erstelle `docs/legacy-analysis.md`:
- Welche Business-Logik existiert (Extraktion, Dedupe-Regeln, Prompts, Routing, Zuordnungen)?
- Aus der Bridge besonders sichern: KI-Prompts für Ticketisierung/Extraktion, Dedupe-Logik, Formular-Feld-Mapping und das komplette HubSpot-Property-Mapping (wird 1:1 für den Sync in Phase 6 gebraucht).
- Welche Prompts/Regeln übernehmen wir inhaltlich (neu implementiert, nicht kopiert)?
- Was wird bewusst NICHT übernommen (Chatwoot-Anbindung, n8n-Glue; HubSpot wandert vom Kernpfad zur optionalen Integration).
Kein Copy-Paste von Legacy-Code ohne mein Review.

## 11. Phasenplan

**Phase 0 — Fundament:** Monorepo + Tooling (pnpm, tsconfig, eslint, vitest, CI), Supabase-Projekt verbinden, Basis-Schema + RLS + Tests, Auth (Org anlegen, Member einladen), Docker-Compose-Skeleton für den Worker (ohne Ingress), `docs/legacy-analysis.md` über alle drei old-*-Ordner. **STOP.**

**Phase 1 — Inbox-Core (kanalunabhängig):** Conversations/Messages/Contacts CRUD, Inbox-UI (Liste mit Filtern, Konversationsansicht, Antworten als Agent, Notizen, Zuweisung, Status, Canned Responses), Realtime-Updates, „Test-Channel" zum manuellen Einspeisen von Nachrichten. **STOP.**

**Phase 2 — Chat-Widget:** Embeddable Script (ein Tag, Shadow DOM), anonyme Sessions + optionale Kontaktdaten-Abfrage, Realtime beidseitig, Theming pro Org (Farbe, Begrüßung), Offline-Verhalten. **STOP.**

**Phase 3 — E-Mail über Resend (Inbound + Versand):**
- Receiving-Subdomain einrichten (MX → Resend, nur Subdomain!), Webhook-Route mit Svix-Verify.
- Adress-Provisionierung im UI: „Neue Intake-Adresse" pro Org → generiert `{{slug}}-{{zweck}}-{{token}}@in.zendori.de`, legt Channel mit sprechendem Namen an (z. B. „Kontaktformular strong-energy.eu").
- Ingest: Routing über `to` → Channel-Lookup (unbekannte Adresse: verwerfen), Body + Anhänge über Receiving-/Attachments-API nachladen → Storage, Idempotenz via Resend-`email_id`, Threading via In-Reply-To/References.
- Versand über Resend-API; Reply-To auf die Intake-Adresse, damit Kundenantworten wieder eingehen. Verifizierte Kundendomain optional pro Org.
- Kontakt in dieser Phase = Envelope-Absender (die KI-Extraktion des echten Formular-Absenders kommt in Phase 4 und korrigiert Contact + Conversation).
**STOP.**

**Phase 4 — Wissensdatenbank + KI (nur Drafts):** kb_sources (URL-Crawl mit Sitemap-Support, Datei-Upload PDF/DOCX→Text, manuelle Einträge), Chunking (~500 Token, 50 Overlap) + Embeddings + Re-Index-Job, Klassifikation (Sprache, Intent, Priorität, „will Mensch"-Flag, Spam), **Ticketisierung mit den Bridge-Prompts: echten Absender (Name/E-Mail/Telefon) und Anliegen aus Formular-Mails extrahieren, Contact/Conversation korrigieren, Dedupe**, RAG-Draft mit Quellenangabe, Confidence-Score, `suggested_reply` in der Inbox mit Übernehmen/Bearbeiten/Verwerfen. **Noch KEIN Auto-Send.** ai_runs-Logging inkl. Kosten. **STOP.**

**Phase 5 — Autopilot + Handoff:** Auto-Send pro Org & Kanal aktivierbar, komplette Handoff-Logik aus §6, Übernehmen/Zurückgeben-UI, Auto-Ack-Texte, Geschäftszeiten. **STOP.**

**Phase 6 — HubSpot-Sync (globale Integration, Bridge-Ablösung):** integrations-Setup pro Org (Private-App-Token, verschlüsselt), **Sync-Regeln: alle Konversationen | nur ausgewählte Kanäle | nur manuell** (Button „An HubSpot senden" pro Konversation gibt es immer), einseitiger Sync: Konversation → HubSpot-Ticket (Property-Mapping aus docs/legacy-analysis.md), Statusänderungen nachziehen, Contact ↔ HubSpot-Kontakt-Matching, Retries über pg-boss, `external_refs.hubspot_ticket_id`. Cutover Bestandskunde: Formular-Empfänger der Strong-Energy-Website auf die Inbound-Adresse umstellen, Parallelbetrieb prüfen, alte Bridge abschalten. **STOP.**

**Phase 7 — WhatsApp:** Meta Cloud API: Webhook-Verify + Signaturprüfung, Ingest (Text, Medien), 24h-Service-Window-Logik, Template-Versand außerhalb des Fensters, Medienversand. **STOP.**

**Phase 8 — IMAP/SMTP-Postfächer (optional):** Bestehendes Kundenpostfach verbinden (Credentials verschlüsselt), Ingest-Worker mit Message-ID-Idempotenz, Threading, HTML→Text-Normalisierung, Anhänge → Storage, SMTP-Versand mit korrekten Reply-Headern. **STOP.**

**Phase 9 — Voice:** erst Provider-Entscheidung mit mir (Testanruf Deutsch: Latenz, Aussprache, Preis, DSGVO/AVV). Danach Umsetzung gemäß §9. **STOP.**

## 12. Deployment

### apps/web → Vercel
- Monorepo-Setup: Root Directory `apps/web`, pnpm, Next.js-15-Preset. Function-Region `fra1` (Frankfurt, nah an Supabase EU).
- Env-Variablen in Vercel, Production/Preview strikt getrennt. Preview-Deploys bekommen NIE produktive Resend-/WhatsApp-/Voice-/Service-Role-Keys.
- Webhooks (Resend, WhatsApp, Voice, Widget) sind Route Handler; schnell antworten (persistieren + `processing_state='pending'` setzen), schwere Arbeit macht der Worker. Für KI-nahe Routen `maxDuration` explizit setzen.
- Verboten in apps/web: IMAP, pg-boss, langlaufende Loops, Filesystem-State. Web ist stateless.
- Öffentliche Hooks/Widget-Routen mit Rate Limit (z. B. Upstash Ratelimit oder eigener Supabase-Counter — Entscheidung mit mir in Phase 2).

### apps/worker → Hetzner (Docker)
- Einzelner Container **ohne Ingress**: kein Traefik, keine Domain, keine offenen Ports — nur ausgehende Verbindungen (Supabase, Anthropic/OpenAI, Resend, Meta Graph API, HubSpot; IMAP/SMTP erst ab Phase 8). Dadurch unabhängig von der restlichen Server-Infrastruktur.
- Immer `sudo docker compose` (v2, mit Leerzeichen), niemals `docker-compose`.
- **Image-Tags pinnen** (feste Node-Version). Keine Auto-Updates/`:latest` — ein Docker-Auto-Update hat auf diesem Server schon mal einen Ausfall verursacht.
- `restart: unless-stopped`, Healthcheck (pg-boss-Heartbeat), Env via `.env` neben der Compose-Datei, nie im Image.
- Deploy-Weg: GitHub Action baut das Worker-Image → GHCR → auf dem VPS `docker compose pull && docker compose up -d`.

## 13. Env-Variablen (Skeleton, `.env.example` pflegen)

Pflege-Orte: apps/web-Variablen in Vercel (Production/Preview getrennt), apps/worker-Variablen in `.env` auf dem VPS.

```
APP_URL=
SUPABASE_URL= / SUPABASE_ANON_KEY= / SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL_SESSION=          # direkte/Session-Verbindung — NUR apps/worker (pg-boss verträgt keinen Transaction-Pooler)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=                # nur Embeddings
MASTER_ENCRYPTION_KEY=         # 32 Byte base64, für channels.config / integrations.config
RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=         # Svix Signing Secret (wird nur einmal beim Anlegen des Webhooks angezeigt)
INBOUND_EMAIL_DOMAIN=          # z. B. in.zendori.de
WHATSAPP_ACCESS_TOKEN= / WHATSAPP_PHONE_NUMBER_ID= / WHATSAPP_VERIFY_TOKEN= / WHATSAPP_APP_SECRET=
# HubSpot-Token: pro Org verschlüsselt in integrations.config, NICHT hier
# Voice-Provider-Keys erst in Phase 9
```

## 14. Definition of Done (pro Feature)

- Typecheck, Lint, Tests grün; RLS-Test für neue Tabellen
- Webhook-/Ingest-Idempotenz getestet (doppelte Zustellung = keine Dublette)
- `.env.example` aktualisiert, kurze Doku in `docs/`
- Manuelle Testanleitung für mich (nummerierte Schritte, erwartetes Ergebnis)
- Keine offenen TODO-Platzhalter im gemergten Code
