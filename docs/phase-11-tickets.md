# Phase 11 — Tickets (Konversation ≠ Ticket)

Owner-Entscheidung 2026-09-04. Stand: **11a gebaut** (Tickets existieren, Bereich, Einstellungen,
alle Erzeugungs-Hooks; HubSpot unverändert). 11b (HubSpot als zwei Ströme + Status-Cutover) folgt.

## Semantik in einem Absatz

Die **Konversation** ist das Gespräch (Inbox, `status open|pending|resolved`, `mode bot|human`).
Ein **Ticket** ist ein Arbeitsobjekt **aus** einer Konversation: eigene ID (`display_id`, Format pro
Org), Status `open | in_progress | waiting | resolved`, Priorität, Zuständiger, HubSpot-Zustand,
Verlaufsausschnitt (Nachrichten ab `opened_at`). Eine Konversation kann über die Zeit mehrere
Tickets haben; solange eines nicht erledigt ist, hängen neue Anlässe daran (**Attach-Regel**,
erzwungen durch `tickets_open_per_conversation_idx`). Nach „Erledigt" öffnet der nächste Anlass ein
neues Ticket.

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
Attach: Gap-Fill Betreff (Platzhalter „Anruf von …" zählt als leer)/Beschreibung/Kategorie,
Priorität nur aufwärts, Zuständiger wenn leer (→ In Bearbeitung), Kontakt-Snapshot aus der
Konversation, `ticket_events{kind:'attached'}`. Verlorenes Rennen (23505) → erneut lesen, anhängen.
Migration 0030 nicht angewendet → `unavailable` → Hooks schweigen.

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

## 11b — Cutover-Checkliste (noch offen)

1. HubSpot als zwei Ströme (`integrations.config.tickets`, `rules.{conversations,tickets}`),
   Ticket-Sync (`hubspot.sync-ticket`, `zendori_ref = ticket.id`, Betreff-Präfix konfigurierbar).
2. `createTicketTool` setzt kein `status:'pending'` mehr; `handoff-sla.ts` prüft „wartet noch?" über
   das offene Ticket; Ticket-Zuweisung/`in_progress` zählt als Reaktion.
3. HubSpot-Panel auf dem Ticket; `ticket_events.hubspot_synced`.

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
