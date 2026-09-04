# Phase 11 — Tickets (Konversation ≠ Ticket)

Owner-Entscheidung 2026-09-04. Stand: **11a + 11b gebaut** — Tickets existieren (0030), Bereich,
Einstellungen, alle Erzeugungs-Hooks, HubSpot als zwei konfigurierbare Ströme, Status-Cutover.

## Semantik in einem Absatz

Die **Konversation** ist das Gespräch (Inbox, `status open|pending|resolved`, `mode bot|human`).
Ein **Ticket** ist ein Arbeitsobjekt **aus** einer Konversation: eigene ID (`display_id`, Format pro
Org), Status `open | in_progress | waiting | resolved`, Priorität, Zuständiger, HubSpot-Zustand,
Verlaufsausschnitt (Nachrichten ab `opened_at`). Eine Konversation kann über die Zeit mehrere
Tickets haben — auch mehrere offene (**Attach-Regel v2**, Phase 12): ein neuer Anlass hängt nur dann
ans neueste offene Ticket, wenn er kein Themenwechsel ist und dieses Ticket jünger als 24 h ist; sonst
entsteht ein neues. Details docs/phase-12-escalation.md.

## Wann entsteht ein Ticket? (Owner: nur, wenn der Bot nicht selbst abschließt)

| Ursprung (`origin`) | Auslöser | Code |
| --- | --- | --- |
| `handoff` | Übergabe (low_confidence / user_request / keyword) | `process-message.ts` `applyHandoff` |
| `intake` | Agent „Reine Annahme" | `applyHandoff(reason:'intake')` |
| `suppressed` | unsichere Antwort bei ausgeschalteter Übergabe (Entwurf bleibt Vorschlag) | else-Zweig nach `recordSuppressedHandoff` |
| `draft_only` | Agent „Nur Entwürfe" — ein Mensch muss den Entwurf bearbeiten | else-Zweig |
| `no_agent` | Kanal ohne Agent (jede Nachricht: erste erzeugt, weitere hängen an) | Agent-Gate |
| `pipeline_failure` | terminaler KI-Fehler (Konversation geht an Menschen) | `handlePipelineFailure` |
| `voice` | Rückruf-Versprechen (`handoff_human` → callback, fehlgeschlagener Transfer) **sofort**; `create_ticket` füllt Betreff/Beschreibung nach (zweiter Aufruf im selben Anruf = Korrektur, überschreibt) | `voice/tools.ts`, `call-session.ts` |
| `form` | jede Formular-Einsendung (eine Konversation je Einsendung) | `api/forms/submit/route.ts` |
| `manual` | Inbox-Button „Ticket anlegen" | `inbox/actions.ts createTicketFromConversation` |
| `takeover` | „Übernehmen" in der Inbox (zugewiesen, In Bearbeitung) | `takeOverConversation` |

**Kein Ticket:** Autopilot-Antworten, Spam/Auto-Reply, erfolgreicher Live-Transfer, verpasste Anrufe
ohne Aufnahme, explizite Entwurfsanforderung (`force_draft`).

Der **einzige** Erzeugungsweg ist `ensureTicket()` in `packages/core/src/ticket-service.ts`
(Worker: Wrapper `apps/worker/src/pipeline/tickets.ts`, fängt alles; Web: direkt mit User-Client).
Attach (`attach:'auto'|'always'|'never'`, `newTopic`, 24-h-Fenster): Gap-Fill Betreff (Platzhalter
„Anruf von …" zählt als leer)/Beschreibung/Kategorie, Priorität nur aufwärts, Zuständiger wenn leer
(→ In Bearbeitung), Kontakt-Snapshot aus der Konversation, `ticket_events{kind:'attached',
details.new_topic}`. Migration 0030 nicht angewendet → `unavailable` → Hooks schweigen.
Unter Eskalationsziel `ticket` (Phase 12) entstehen `handoff`/`intake`-Tickets ohne Moduswechsel.

## Datenmodell (Migration 0030)

- `tickets` — Spalten siehe Migration; `number` + `display_id` vergibt der BEFORE-INSERT-Trigger
  (`private.prepare_ticket_row`) über `public.allocate_ticket_number(org)` (Zähler `ticket_counters`,
  Row-Lock, läuft in der Insert-Transaktion) und `private.render_ticket_display_id(format, n, at)`.
  Identitätsspalten und der Worker-eigene HubSpot-Zustand sind für authenticated unveränderlich.
- `ticket_events` — Zeitleiste (`created`/`status_changed`/`assigned` per Trigger, `attached`/`note`
  von der App, `hubspot_synced` ab 11b), inhaltsfrei.
- `org_settings.ticket_id_format` (Default `#{N}`; Tokens `{N}`, `{NNNN…}` mit führenden Nullen —
  nie gekürzt —, `{YYYY}`, `{YY}`, Jahr in Europe/Berlin) + `ticket_number_start` (gilt nur vor dem
  ersten Ticket). `formatTicketId()` in `packages/core/src/tickets.ts` rendert Token-für-Token
  identisch zur SQL-Funktion (RLS-Test).
- Rechte: Bereich `tickets` (`AREA_DEFS`, bis „Bearbeiten"); Backfill in 0030 gibt bestehenden
  Mitarbeitern dieselbe Stufe wie „Posteingang". Kanal-Scope wirkt über `tickets.channel_id`
  (`hasTicketEdit`). Realtime: `tickets` in der Publication.
- Suche: `public.search_tickets` (0028-Muster) über display_id/subject/description/Kontakt.

## Bereich „Tickets" (Web)

`/tickets` (Liste: Tabs Aktiv | Offen | In Bearbeitung | Wartet | Erledigt | Alle, Filter
Priorität/Zuständig/Kanal/Suche) → `/tickets/[id]` (Bearbeitung, Anliegen, Kontakt, Verlauf ab
`opened_at` über die geteilte `MessageThread`, Notizen der Konversation, Zeitleiste).
Inbox: Sektion „Tickets" in der Seitenleiste (Chips, „Ticket anlegen"), Chip im Konversationskopf.
Einstellungen → Tab „Tickets": Format mit Live-Vorschau + Startnummer (owner/admin).

## Konversations-Split

`shouldStartNewConversation` bekommt `hasOpenTicket`: ein offenes Ticket verhindert die
Ticket-Trennung (WhatsApp-Route, Widget-Resume prüfen lazy per `findOpenTicket`).

## Voice

Die Ticketnummer wird **nicht** vorgelesen (Owner-Regel 2026-09-03). Die System-Nachricht in der
Inbox trägt sie („Ticket #12 aufgenommen: …"). Follow-up-Idee: org-Toggle
`voice_announce_ticket_id`.

## HubSpot: zwei Ströme (11b)

`integrations.config` trägt neben dem Konversations-Strom (`pipeline_id/default_stage_id/
resolved_stage_id`, Phase 6) den Block `tickets: { pipeline_id, default_stage_id, resolved_stage_id?,
subject_prefix }`; `integrations.rules` ist `{ conversations: Regel, tickets: Regel }` (die flache
Alt-Form wird als Konversations-Strom gelesen, Tickets dann „manuell" — `parseHubspotSyncRules`).
Einstellungen → Integrationen zeigt beide Ströme mit Pipeline/Stages/Regel; ohne Ticket-Pipeline
werden Tickets nicht übertragen.

- **Ticket-Strom** (`syncTicket`, Queue `hubspot.sync-ticket`, Anker `zendori_ref = tickets.id`,
  Scan über `tickets.hubspot_sync_requested_at/hubspot_synced_at`): Betreff `[display_id] Betreff`
  (Toggle), Inhalt = Beschreibung + Eröffnungsnachricht (Text) bzw. komplettes Transkript (Voice)
  + „— Zendori-Ticket …", Folge-Nachrichten ab Wasserzeichen (nie vor `opened_at`) als Notizen,
  „Erledigt" → Erledigt-Stage. `ticket_events.hubspot_synced` beim Anlegen.
- **Auslöser:** `ensureTicket` (created + attached) armt den Sync, wenn die Ticket-Regel den Kanal
  deckt **oder** das Ticket schon in HubSpot ist (`ticketSyncWanted`); Folge-Nachrichten in
  menschgeführten Konversationen und der Voice-Post-Call re-armen offene Tickets
  (`requestConversationTicketsResync`); „Erledigt" armt bei bereits gesendetem Ticket oder passender
  Regel. Buttons: Ticket-Detail „An HubSpot senden", Inbox-Seitenleiste „Ticket an HubSpot senden"
  (legt bei Bedarf ein manuelles Ticket an).
- **Konversations-Strom** bleibt unverändert (sechs Aufrufstellen, `status='hubspot_sent'`).

## Status-Cutover (11b)

`create_ticket` (Voice) setzt die Konversation nicht mehr auf `pending` — das offene Ticket ist der
Warteschlangeneintrag; Übergaben (Text/Voice/Übernahme) setzen `pending` weiterhin. Die
SLA-Erinnerung gilt als „wartet noch", wenn die Konversation `pending` ist **oder** ein
unzugewiesenes offenes Ticket existiert; ein zugewiesenes/in Bearbeitung befindliches Ticket zählt
als Reaktion.

## Manueller Test (11a)

1. Migration 0030 anwenden, Web + Worker deployen.
2. Einstellungen → Tickets: Format `ZD-{YYYY}-{NNNN}` → Vorschau `ZD-2026-0001`, speichern.
   Als Mitarbeiter: Tab sichtbar, Formular deaktiviert.
3. Test-Kanal mit „Nur Entwürfe"-Agent: Nachricht senden → Inbox-Seitenleiste zeigt Chip
   `ZD-2026-0001 · Offen`, `/tickets` listet es mit Ursprung „Entwurf".
4. Agent auf Autopilot (Schwellwert 0.1), einfache FAQ-Frage → Antwort, **kein** neues Ticket.
5. Nachricht mit Eskalations-Begriff → Übergabe → **dasselbe** Ticket (Zeitleiste „Neuer Anlass
   angehängt (Übergabe)"), kein zweites.
6. Ticket auf „Erledigt" → Zeitleiste; erneute Keyword-Nachricht → **neues** Ticket `…0002`.
7. Voice: Frage, die der Agent nicht beantworten kann → Rückruf-Versprechen → Ticket sofort
   („Anruf von …"); Anliegen aufnehmen lassen → Betreff/Beschreibung gefüllt; keine Nummer hörbar.
8. Formular `/f/{token}` einsenden → Ticket „Formular" mit Betreff aus dem role-Feld.
9. Inbox: Konversation ohne Ticket → „Ticket anlegen" → „Manuell"; „Übernehmen" auf einer anderen →
   „Übernahme", zugewiesen, In Bearbeitung.
10. Rechte: Mitarbeiter ohne Tickets-Chip → kein Nav-Eintrag, `/tickets` „Kein Zugriff", Chips nur
    Text; mit Ansehen + Kanal-Scope → nur diese Kanäle, Auswahlfelder deaktiviert.
11. Realtime: `/tickets` offen lassen, Übergabe in anderem Tab → Liste aktualisiert sich.
12. Suche `?q=ZD-2026-0002` und Kontakt-E-Mail-Fragment treffen.

## Manueller Test (11b)

1. Einstellungen → Integrationen: Ticket-Pipeline + Standard-Stage wählen, Regel „Alle Tickets",
   Präfix an; Konversations-Regel „Nur manuell". Speichern.
2. Übergabe im Test-Kanal auslösen → Ticket entsteht → innerhalb von Sekunden ein HubSpot-Ticket
   `[ZD-2026-000x] …` in der Ticket-Pipeline (Inhalt: Beschreibung + erste Nachricht + Fußzeile);
   Ticket-Detail zeigt „In HubSpot" + Deep-Link; Zeitleiste „An HubSpot übertragen".
3. Weitere Kundennachricht auf derselben (menschgeführten) Konversation → Notiz am HubSpot-Ticket.
4. Ticket „Erledigt" → HubSpot-Stage wechselt.
5. Präfix-Toggle aus → nächstes Ticket ohne Klammer. Regel „Nur manuell" → kein automatischer
   Sync; Button „An HubSpot senden" auf dem Ticket funktioniert; ohne Ticket-Pipeline meldet er
   den Konfigurationshinweis.
6. Konversations-Regel „Alle" zusätzlich → dieselbe Anfrage erzeugt zwei HubSpot-Tickets in zwei
   Pipelines (gewollt: zwei Ströme), keine Dublette innerhalb eines Stroms.
7. Voice: Rückruf-Versprechen → Ticket → nach Auflegen Transkript-Notizen am HubSpot-Ticket;
   Konversation bleibt `open` (kein `pending` mehr durch `create_ticket`).
