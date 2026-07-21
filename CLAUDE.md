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
- **E-Mail (bestehende Postfächer): Weiterleitung statt IMAP.** Kunden binden ihr Postfach per E-Mail-Weiterleitung auf eine Resend-Inbound-Adresse an (gleiche Mechanik wie Formular-Intake, serverless). Direktes IMAP/SMTP (ursprünglich Phase 8) ist **gestrichen** — siehe §11.
- **WhatsApp (provider-agnostisch, pro Org eigene Nummer):** ein Kanaltyp `whatsapp`, Backend pro Channel über `config.provider`:
  - **Twilio** — Operator (Novax) besitzt die WhatsApp-Sender, eine Nummer je Kunde; Routing über die `To`-Nummer, Verify `X-Twilio-Signature`.
  - **Meta WhatsApp Cloud API direkt** — Kunde besitzt seine eigene Nummer/WABA, verbunden per **Embedded Signup (Tech Provider)**; Routing über `phone_number_id`, Verify `X-Hub-Signature-256`.
  - Beide hinter _einem_ Adapter (`packages/channels/whatsapp`, dispatch auf `provider`), gleiche `UnifiedInboundMessage`/`OutboundMessage`; Credentials pro Org verschlüsselt in `channels.config`. Twilio ist hier bewusst erlaubt — die frühere „kein Twilio"-Regel ist damit aufgehoben.
- **Chat:** eigenes Embeddable Widget (ein Script-Tag) + Supabase Realtime.
- **HubSpot (optional, Phase 6):** einseitiger Ticket-Sync pro Org mit Sync-Regeln (alle Konversationen | nur ausgewählte Kanäle | nur manuell). Kein Kern-Bestandteil.
- **Voice (Phase 9): xAI Voice API + Twilio als reiner Nummern-/SIP-Trunk-Lieferant** (Entscheidung getroffen; ElevenLabs verworfen). Formaler Go/No-Go bleibt der deutsche Testanruf vor Phasenstart. API ist OpenAI-Realtime-kompatibel → Plan B OpenAI Realtime mit fast gleichem Code. NICHT vorab implementieren. Details §9.
- **Deployment:** apps/web → **Vercel** (Region `fra1`), apps/worker → Docker-Container auf dem bestehenden Hetzner VPS (Details §12).
- Validierung: `zod` überall an Systemgrenzen. Tests: `vitest`. Logging: `pino`.

## 4. Monorepo-Layout

```
apps/web        → Next.js: Inbox, Settings, Widget-Host, Webhooks (/api/hooks/*), Resend-Ingest
apps/worker     → Node-Prozess: pg-boss Worker (KI-Pipeline, Crawler, HubSpot-Sync, WhatsApp-Versand, ab Phase 9 Voice-WebSocket-Sessions)
packages/core   → Domain-Typen, zod-Schemas, DB-Client, Verschlüsselung
packages/channels → Adapter: chat | email | whatsapp (meta|twilio) | voice (ein Interface)
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
- `agents` (org_id, name, **identity — der System-Prompt/die Identität des Agenten**, kind: text|voice [0015], mode: draft_only|autopilot|intake_only [voice: nur intake_only|autopilot], confidence_threshold default 0.7, handoff_enabled default true [0018, §6], is_active) — KI-Agenten als eigene Entität (Migration 0011): ein Agent bedient beliebig viele Kanäle; Kanal ohne Agent = keine Drafts/Auto-Sends (Klassifikation+Extraktion laufen immer). Writes owner-only.
- `channels` (org_id, type: chat|email|whatsapp|voice, name, config jsonb, is_active, agent_id → agents; same-org per Composite-FK, Zuweisung owner-only per DB-Trigger)
  - email-Channel: `config.mode: 'inbound' | 'imap'`; bei inbound: `config.address` (die generierte Adresse), bei imap: verschlüsselte Credentials (§7)
- `integrations` (org_id, type: hubspot, config jsonb — Token verschlüsselt wie §7, rules jsonb — Sync-Regeln: all | channel_ids[] | manual, is_active, last_sync_at)
- `contacts` (org_id, name, email, phone, wa_id, external_ids jsonb) — Identitäten mergen, wenn E-Mail/Telefon übereinstimmt; bei Formular-Mails wird der echte Kontakt per KI-Extraktion gesetzt (Phase 4), nicht der Envelope-Absender
- `conversations` (org_id, channel_id, contact_id, subject, status: open|pending|resolved, **mode: bot|human**, assignee_id, priority, last_message_at, external_refs jsonb — z. B. hubspot_ticket_id)
- `messages` (conversation_id, direction: in|out, sender_type: contact|agent|bot|system, content, content_type: text|html|audio|image|file, external_id, metadata jsonb, processing_state: pending|done|skipped — nur für direction=in relevant, Basis für den Worker-Poll)
- `attachments` (message_id, storage_path, mime, size)
- `notes` (conversation_id, author_id, content) — intern, nie an Kunden
- `canned_responses` (org_id, shortcut, content)
- `knowledge_bases` (org_id, name, description) — mehrere Wissensdatenbanken pro Org (0012); Inhalte member-verwaltet
- `kb_sources` (org_id, knowledge_base_id → knowledge_bases, type: url|file|text, uri, status: pending|indexed|error, last_indexed_at) — jede Quelle gehört zu genau einer Wissensdatenbank
- `agent_knowledge_bases` (org_id, agent_id, knowledge_base_id) — n:m: welche Datenbanken ein Agent nutzt (owner-only; RAG-Suche filtert darauf, Agent ohne Verknüpfung findet nichts)
- `kb_chunks` (source_id, org_id, content, embedding vector(1536), fts tsvector [0013, generiert/german], token_count) — Retrieval zweistufig: hybrid_kb_search (Vektor+Keyword, RRF) → Haiku-Rerank (Text-Pipeline; Voice ohne Rerank wegen Latenz)
- `ai_runs` (conversation_id, step, model, input_summary, output_summary, confidence, latency_ms, cost_usd)
- `handoff_events` (conversation_id, reason: low_confidence|user_request|keyword|manual|intake, outcome: pending_human|transferred|transfer_failed|callback_ticket|suppressed [0018, nullable — Alt-Zeilen bleiben NULL], details jsonb content-frei, triggered_by)
- `org_settings` (org_id, escalation_keywords, business_hours, auto_ack_texts, handoff_sla_minutes [0018, null = aus]) — seit 0011 nur noch org-weite Übergabe-Regeln; Autopilot/Schwellwert/Ton sind auf die `agents` gewandert (die Alt-Spalten autopilot_enabled/confidence_threshold/tone_instructions stehen ungenutzt bis zu einer Cleanup-Migration)

## 6. Human-Handoff-Logik (verbindlich)

Default: `mode = 'bot'`. Handoff-Trigger:

1. `confidence < threshold` (org-konfigurierbar) — **nur wenn `agents.handoff_enabled` (0018) an ist.** Schalter aus ⇒ Trigger unterdrückt: KEIN Auto-Send der unsicheren Antwort (Entwurf bleibt Vorschlag — der Agent verhält sich für diese Nachricht wie draft_only; Voice: ehrliches „kann ich gerade nicht sagen" + Ticket-Angebot) und ein `handoff_events`-Eintrag mit `outcome='suppressed'` macht die Unterdrückung zählbar.
2. Kunde verlangt explizit einen Menschen (Klassifikations-Flag) — **übergeht den Schalter immer.**
3. Eskalations-Keywords (org-konfigurierbar in „Übergabe & Zeiten"; die Liste gilt für Text UND Voice — sie wird in den Voice-Prompt injiziert) — **übergeht den Schalter immer** (deaktivieren = Liste leeren).
4. Agent klickt „Übernehmen" in der Inbox — immer.

Bei Handoff: `mode = 'human'`, `status = 'pending'`, `handoff_events`-Eintrag (0018: mit `outcome` pending_human|transferred|transfer_failed|callback_ticket|suppressed und content-freiem `details` jsonb), Realtime-Notification, optional Auto-Ack an den Kunden („Ein Mitarbeiter übernimmt…", pro Org konfigurierbar, außerhalb Geschäftszeiten anderer Text). Text übergibt innerhalb UND außerhalb der Geschäftszeiten — nur der Ack-Text unterscheidet sich.

**Voice (Geschäftszeiten-Gate im Moment des Tool-Aufrufs, nicht bei Anrufbeginn):** innerhalb der Zeiten + Transfer-Nummer ⇒ Live-Transfer (SIP REFER) mit Erwartungs-Ansage („…sollten Sie niemanden erreichen, melden wir uns zurück" — nach erfolgreichem REFER ist Nicht-Abheben nicht beobachtbar); außerhalb / ohne Nummer ⇒ Rückruf-Ticket. Geschäftszeiten ohne einen einzigen gepflegten Tag = NICHT konfiguriert ⇒ Transfer erlaubt (die Nummer ist das Opt-in). Der agentenlose Safe-Intake-Fallback transferiert nie. Jedes Rückruf-Versprechen (auch `create_ticket` ohne Handoff) setzt `status='pending'` — EINE Warteschlange für alles.

**SLA-Erinnerung:** `org_settings.handoff_sla_minutes` (leer = aus) — wartende Übergabe ohne Mitarbeiter-Reaktion bekommt nach Ablauf eine interne Notiz; nur innerhalb der Geschäftszeiten, idempotent pro Event, `outcome='transferred'` ausgenommen.

Agent kann per Klick an den Bot zurückgeben (`mode = 'bot'`).
Solange `mode = 'human'`: Bot generiert **keine** Antworten, auch keine Drafts, außer Agent fordert explizit einen Draft an.

## 7. Sicherheit & DSGVO (nicht verhandelbar)

- Alle Daten in EU (Supabase EU, Hetzner). Keine US-Datenverarbeitung ohne explizite Freigabe von mir.
  - **Bewusste, freigegebene Ausnahme: Resend** als E-Mail-Provider (bereits im Einsatz). Vor Kunden-Rollout: AVV/SCCs und Speicherorte prüfen — Aufgabe von mir, im Code nichts weiter nötig.
  - **Weitere freigegebene US-Processor-Ausnahmen (mit mir entschieden):** WhatsApp über **Meta** und **Twilio** (Phase 7) sowie **xAI Voice** + Twilio-SIP (Phase 9). Gleiche Auflage wie Resend: vor Produktiv-Rollout AVV/SCCs/DPAs unterschreiben und Speicherorte dokumentieren — Aufgabe von mir. Hinweis: Meta hat **keine** EU-resident WhatsApp-Option; bei Twilio/xAI EU-Region prüfen, wo verfügbar. Kein Produktivkunde vor DPA-Freigabe (bis dahin nur Test-/Sandbox-Nummern).
- Secrets nur via `.env` / Server-Env. Nie ins Repo. `.env.example` immer aktuell halten.
- Kanal- und Integrations-Credentials (IMAP/SMTP-Passwörter, WhatsApp-Tokens, HubSpot-Token) verschlüsselt in `channels.config` bzw. `integrations.config`: libsodium secretbox mit `MASTER_ENCRYPTION_KEY` aus Env. Nie im Klartext loggen oder an den Client geben.
- Webhooks verifizieren: Resend per Svix-Signatur (`resend.webhooks.verify`, Raw Body!), WhatsApp-Meta per `X-Hub-Signature-256` (App Secret, Raw Body), WhatsApp-Twilio per `X-Twilio-Signature` (Auth Token, exakte öffentliche URL aus `APP_URL` + sortierte Params — NICHT aus dem Proxy-Host rekonstruieren), Voice per signiertem xAI-Webhook (Secret pro Nummer), Widget-Requests mit org-gebundenem Public Token + Rate Limit. Unbekannte Inbound-Adressen/Nummern: loggen (nur Metadaten) und verwerfen.
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

## 9. Voice-Integration (Phase 9 — xAI Voice API + Twilio-SIP)

Provider-Entscheidung getroffen: **xAI Voice API** (OpenAI-Realtime-kompatibel → Plan B OpenAI Realtime mit fast gleichem Code); **Twilio** liefert nur Nummer + SIP-Trunk. Formaler Start erst nach deutschem Testanruf (§11 Phase 9). Kernarchitektur:

- **Kein persistentes Agent-Objekt beim Provider.** Ein „Agent" = die `session.update`-Config beim Call-Join (System-Prompt, Stimme, Keyterms, Tools, Transfer-Nummer). Pro Org in `channels.config` (type=voice) gespeichert und beim Session-Start gesetzt — das ideale Multi-Tenant-Modell (kein Setup pro Kunde beim Provider außer der Nummer).
- **Anruf-Flow:** eingehender Anruf → xAI schickt signierten Webhook (`call_id` + SIP `From`/`To`) an `POST /api/hooks/voice` (Vercel, schnell, nichts Langlaufendes) → Vercel schreibt eine `voice_calls`-Zeile. Der **Worker (Hetzner) hört per Supabase Realtime** auf diese Inserts (ausgehende Verbindung, **kein Ingress** nötig — §12) und **joint sofort den WebSocket `?call_id`**, der für die Dauer des Anrufs im Worker lebt. Audio bridged xAI, Zendori fasst es nie an. (Der 3-s-DB-Poll wäre fürs Klingeln zu langsam → Realtime-Push, gleiches Muster wie Migration 0003.)
- **Routing:** gewählte Nummer (`To`) → voice-Channel → Org → deren Voice-Config laden → damit joinen. Kontakt-Matching über die Anrufernummer.
- **Tools laufen im Zendori-Worker** (nicht beim Provider), `org_id` beim Session-Start gebunden → RLS-Scoping, strikte Mandantentrennung. Mindestens: `kb_search` (gleiche RAG-Funktion wie die Text-Pipeline, Supabase — KB bleibt bei uns, NICHT als xAI-Collection), `create_ticket`/Ticketisierung, `handoff`. Umsetzung als Function-Tools über die Session oder als MCP-Server.
- **Handoff (§6):** xAI `refer` = Transfer an ein PSTN/SIP-Ziel (Live-Transfer-Nummer der Org), `hangup` = Auflegen; Rückruf-Ticket bei Nicht-Erreichbarkeit. DTMF wird als Text ans Modell gegeben.
- **Nummern:** Twilio-Nummer per API kaufen (geteilte Nummern-Infra mit Phase 7), Direct-SIP-Trunk `sip:{nummer}@sip.voice.x.ai`, bei xAI registrieren (`POST /v2/phone-numbers`, origin `byo_trunk`); das einmalige Webhook-Signing-Secret verschlüsselt in `channels.config`. `bundle_sid` pro Org (Default = Novax-Bundle, Rufumleitungs-Modell), Kunden-Bundle-Flow für eigene öffentliche Nummern.
- **Deutsch:** offiziell (`de`, auto-detect, `language_hint`, bis 100 Keyterms, optional Custom Voice aus ≤120 s Referenzclip). `force_message` für Pflichtansagen (z. B. Aufzeichnungshinweis), Per-Response-Instructions für dynamischen Kontext (bekannter Kontakt / offene Tickets).
- Auth: signierter xAI-Webhook (Secret pro Nummer), Requests zod-validiert. Anrufe erscheinen als ganz normale Konversationen (channel=voice), Transkript-Turns als `messages`, optional Audio-Recording in Storage.
- **DSGVO:** xAI ist US-Processor (freigegebene §7-Ausnahme; DPA/EU-Residency prüfen vor Rollout — meine Aufgabe). Zunächst nur Inbound; Outbound später klären.

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

**Phase 7 — WhatsApp (provider-agnostisch, pro Org eigene Nummer):** ein Kanaltyp `whatsapp`, Backend pro Channel über `config.provider` (discriminated union). Keine DB-Migration nötig (jsonb-config + bestehender `(channel_id, external_id)`-Index). **Sub-Reihenfolge (STOP zwischen 7a und 7b):**

- **7a — Gemeinsames Skelett + Twilio (zuerst, sofort startklar):** Config-Union `meta|twilio`, Adapter-Dispatch `packages/channels/whatsapp`, provider-unabhängiger 24h-Service-Window-Helper, Webhook-Route `/api/hooks/whatsapp/twilio` (Verify `X-Twilio-Signature`, Routing über `To`, Ingest Text/Medien mit Basic-Auth-Download, Idempotenz `MessageSid`), Versand freiform im Fenster / **Content-Template** (`ContentSid`) außerhalb, Settings-UI „WhatsApp verbinden (Twilio)". Sub-Account je Kunde empfohlen. **STOP.**
- **7b — Meta Cloud API via Embedded Signup:** ein App/Webhook/App-Secret (Tech Provider), Route `/api/hooks/whatsapp/meta` (GET-`hub.challenge`-Handshake, POST `X-Hub-Signature-256` über Raw Body, Routing über `phone_number_id`, Idempotenz `wamid`), Versand Text im Fenster / **Template** (`name`+`language`) außerhalb, Medien über Graph-Media-API, Self-Service-Onboarding-Popup. Meta-Tech-Provider-Verifizierung ist Voraussetzung (Vorlaufzeit — früh anstoßen). **STOP.**

**Phase 8 — IMAP/SMTP: ENTFÄLLT.** Bestehende Kundenpostfächer werden per **E-Mail-Weiterleitung auf eine Resend-Inbound-Adresse** angebunden (Phase-3-Mechanik, serverless, kein IMAP). Zwei Use-Cases, je eigene Intake-Adresse = eigener Kanal: Formular-Weiterleitung und E-Mail-Weiterleitung. Einziger Zusatz: `channels.config.purpose: 'form' | 'forwarded_email'`, damit die Phase-4-Extraktion bei weitergeleiteten Mails den echten Absender aus dem Weiterleitungs-Header (statt aus einem Formular-Block) zieht. (Klein, kann an Phase 3/4 angehängt werden.)

**Phase 9 — Voice (xAI + Twilio-SIP):** erst deutscher Testanruf mit mir (Latenz, Aussprache, Custom Voice, Preis, DSGVO/DPA), dann Umsetzung gemäß §9 (Worker-WebSocket-Session, Supabase-Realtime-Trigger statt Poll, Tools im Worker mit org_id/RLS, `refer`-Handoff, Twilio-SIP-Trunk-Provisionierung, `voice_calls`-Tabelle). **STOP.**

## 12. Deployment

### apps/web → Vercel

- Monorepo-Setup: Root Directory `apps/web`, pnpm, Next.js-15-Preset. Function-Region `fra1` (Frankfurt, nah an Supabase EU).
- Env-Variablen in Vercel, Production/Preview strikt getrennt. Preview-Deploys bekommen NIE produktive Resend-/WhatsApp-/Voice-/Service-Role-Keys.
- Webhooks (Resend, WhatsApp, Voice, Widget) sind Route Handler; schnell antworten (persistieren + `processing_state='pending'` setzen), schwere Arbeit macht der Worker. Für KI-nahe Routen `maxDuration` explizit setzen.
- Verboten in apps/web: IMAP, pg-boss, langlaufende Loops, Filesystem-State. Web ist stateless.
- Öffentliche Hooks/Widget-Routen mit Rate Limit (z. B. Upstash Ratelimit oder eigener Supabase-Counter — Entscheidung mit mir in Phase 2).

### apps/worker → Hetzner (Docker)

- Einzelner Container **ohne Ingress**: kein Traefik, keine Domain, keine offenen Ports — nur ausgehende Verbindungen (Supabase inkl. Realtime, Anthropic/OpenAI, Resend, Meta Graph API, Twilio, HubSpot; ab Phase 9 ausgehender WebSocket zu xAI). Dadurch unabhängig von der restlichen Server-Infrastruktur. Wichtig für Phase 9: Der Voice-Anruf-WebSocket ist eine **ausgehende** Verbindung, die per Supabase-Realtime-Push (nicht Ingress) getriggert wird — die Ingress-freie Regel bleibt gültig.
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
# WhatsApp Meta — nur Plattform-Ebene für Embedded Signup (access_token + phone_number_id pro Org in channels.config):
WHATSAPP_APP_ID= / WHATSAPP_APP_SECRET= / WHATSAPP_VERIFY_TOKEN= / WHATSAPP_CONFIG_ID=
# WhatsApp Twilio (+ Voice-Twilio): AccountSid/AuthToken (+ ggf. API-Key SK/Secret) pro Org verschlüsselt in channels.config, NICHT hier
# HubSpot-Token: pro Org verschlüsselt in integrations.config, NICHT hier
# Voice (Phase 9): XAI_API_KEY= (+ EU-Endpoint wo verfügbar); xAI-Webhook-Signing-Secret pro Nummer in channels.config, NICHT hier
```

## 14. Definition of Done (pro Feature)

- Typecheck, Lint, Tests grün; RLS-Test für neue Tabellen
- Webhook-/Ingest-Idempotenz getestet (doppelte Zustellung = keine Dublette)
- `.env.example` aktualisiert, kurze Doku in `docs/`
- Manuelle Testanleitung für mich (nummerierte Schritte, erwartetes Ergebnis)
- Keine offenen TODO-Platzhalter im gemergten Code
