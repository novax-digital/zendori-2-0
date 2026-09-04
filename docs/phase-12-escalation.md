# Phase 12 — Eskalationsziel pro Agent + Attach-Regel v2

Owner-Entscheidungen 2026-09-04. Stand: **gebaut** (Migration 0031).

## Warum

Nach Phase 11 hingen „Wann übernimmt ein Mensch?", „Wann entsteht ein Ticket?" und „Was, wenn es
gar keinen Menschen gibt?" an drei Schaltern: `handoff_enabled` schaltete nur Unsicherheit ab,
Eskalations-Begriffe und Kundenwunsch führten **immer** zur Live-Übergabe — für Kunden ohne Team
verstummte die Konversation. Jetzt gibt es **ein** Eskalationsziel pro Agent und **einheitliche**
Auslöser.

## Die Matrix

`agents.escalation_target` = `human` (Live-Übergabe, heutiges Verhalten, Default) | `ticket` (kein
Mensch live). `agents.handoff_enabled` bleibt und heißt jetzt „**auch bei Unsicherheit** (unter dem
Schwellwert) eskalieren".

| Auslöser | Ziel `human` | Ziel `ticket` |
| --- | --- | --- |
| Eskalations-Begriff · Kunde will Mensch · Unsicherheit (wenn `handoff_enabled`) | `applyHandoff`: `mode='human'`, `status='pending'`, `handoff_events(pending_human)`, Ticket, Übergabe-Bestätigung | `applyTicketEscalation`: **kein** Moduswechsel, Ticket (neu oder attach), `handoff_events(callback_ticket)` einmal pro Ticket, Ticket-Bestätigung, Entwurf bleibt Vorschlag, Bot antwortet weiter |
| Unsicherheit mit `handoff_enabled=false` | unterdrückt (Entwurf = Vorschlag, Ticket `suppressed`) | identisch |
| Reine Annahme | `applyHandoff(intake)` | Ticket `intake` + Bestätigung bei der ersten Nachricht, Folge-Nachrichten hängen still an |
| Voice `handoff_human` | Transfer (Nummer + Geschäftszeit) sonst Rückruf, `mode='human'` | **nie** Transfer, **kein** Moduswechsel, Rückruf-Aufnahme; Prompt verspricht keine Verbindung |
| Pipeline-Fehler | Flip + `pending_human` + Ticket + Notiz | kein Flip, Ticket + `callback_ticket` + Notiz (Ziel via Kanal→Agent; Fehler ⇒ `human`) |
| Autopilot sicher / Spam | kein Ticket | identisch |

Code: `decideEscalation`/`decideDraftAction` (`apps/worker/src/pipeline/handoff.ts`),
`escalate`/`applyTicketEscalation` (`process-message.ts`), `decideVoiceHandoff` Zweig `ticket`
(`apps/worker/src/voice/tools.ts`), `buildHandoffTool`/`humanRequestRules`/`userRequestRule`
(`session-config.ts`).

## Bestätigungen (Ziel `ticket`, Text-Kanäle)

`org_settings.ticket_ack_texts` (`{enabled, in_hours, out_of_hours}`, Placeholder `{ticket_id}`,
**standardmäßig an**, leere Felder ⇒ Standardtext):

- neues Ticket ⇒ „Vielen Dank, wir haben Ihr Anliegen unter {ticket_id} aufgenommen und melden uns
  schnellstmöglich." (`DEFAULT_TICKET_ACK_TEXT`)
- Ergänzung zum offenen Ticket (attach; nicht bei Reiner Annahme) ⇒ „Vielen Dank, Ihre Ergänzung zu
  {ticket_id} ist aufgenommen — wir melden uns." (`DEFAULT_TICKET_FOLLOWUP_ACK_TEXT`, fest)
- Voice nennt weiterhin keine Nummer. `callback_ticket`-Event nur bei neuem Ticket (eine SLA-Zusage).

Einstellungen → Übergabe & Zeiten → Panel „Ticket-Bestätigung"; Agenten-Editor → „Wenn der Agent
nicht weiterkommt" (Radios) + „Auch bei Unsicherheit eskalieren".

## Attach-Regel v2 („die Konversation geht immer weiter")

Eine Eskalation hängt nur dann ans **neueste** nicht-erledigte Ticket der Konversation, wenn die
Nachricht **kein Themenwechsel** ist (`classification.is_new_topic === false`) **und** dieses Ticket
**jünger als 24 h** ist; sonst entsteht ein neues Ticket — auch wenn ältere offen sind. Gleiche
`opened_message_id` ⇒ immer attach (Retry-Idempotenz). `attach:'always'` (Voice im Anruf,
Übernahme, HubSpot-Button) / `attach:'never'` (Formular, „Ticket anlegen"). Der 0030-Index
`tickets_open_per_conversation_idx` ist gefallen. `ticket_events.details.new_topic` erlaubt das
Nachjustieren. HubSpot-Folge-Notizen gehen nur ans neueste offene Ticket; die SLA-Erinnerung prüft
bevorzugt das Ticket aus `handoff_events.details.ticket_id`.

## Manueller Test

1. Migration 0031 angewendet, Web + Worker deployt. Agenten-Editor zeigt „Wenn der Agent nicht
   weiterkommt" (2 Radios) + „Auch bei Unsicherheit … eskalieren"; Übergabe & Zeiten zeigt
   „Ticket-Bestätigung" (an, Felder leer).
2. Text-Agent (Autopilot, Schwellwert 0.1) auf „Als Ticket aufnehmen". FAQ-Frage → Antwort, kein
   Ticket.
3. „Ich reiche meine Kündigung ein" → Konversation bleibt `bot`/`open`, Chip `#N · Offen`, Kunde
   erhält „…unter #N aufgenommen…", `/tickets` listet es (Ursprung „Übergabe").
4. FAQ-Frage danach → Bot antwortet weiter.
5. Nachfrage zum selben Thema, unbeantwortbar (< 24 h) → hängt an #N (Zeitleiste „angehängt"),
   kurze Bestätigung „Ihre Ergänzung zu #N…", kein zweites Ticket; Entwurf liegt als Vorschlag im
   Posteingang.
6. Neues unbeantwortbares Thema („Meine Wallbox zeigt Fehler E42") → #N+1 mit eigener Bestätigung;
   #N bleibt offen.
7. „Ticket anlegen" in der Inbox trotz offener Tickets → drittes Ticket „Manuell".
8. Ziel zurück auf „Mensch", Keyword-Nachricht → `pending`, Übergabe-Hinweis, Auto-Ack (falls an).
9. Eigener Bestätigungstext mit `{ticket_id}` → wird genutzt; Häkchen aus → kein Kundentext.
10. Voice-Agent (Autopilot, Transfer-Nummer gesetzt, innerhalb Geschäftszeiten) auf „Ticket": Frage
    außerhalb der KB → kein Transfer, „ich nehme Ihr Anliegen auf, ein Mitarbeiter meldet sich",
    Name/Rückrufnummer, Ticket, keine Nummer hörbar, Konversation bleibt `bot`/`open`,
    `handoff_events.outcome='callback_ticket'`.
11. Voice „Ich möchte einen Mitarbeiter sprechen" → dasselbe.
12. „Reine Annahme" + Ticket: erste Nachricht Ticket + Bestätigung, Modus `bot`; zweite hängt still
    an.
13. SLA 5 min, Ticket unzugewiesen → interne Notiz; zugewiesen → keine.
14. HubSpot (Ticket-Regel „Alle"): Notizen landen nur am neuesten offenen Ticket.

## Bewusst offen

- `is_new_topic` war bisher nur Messwert; Fehlklassifikation ⇒ ein Ticket zu viel oder Attach bis
  das 24-h-Fenster schließt.
- Voice-Wortlaut ist Prompt-Ebene; hart garantiert ist nur: unter Ziel `ticket` transferiert das
  Werkzeug nie.
- E-Mail-Bestätigungen sind echte Mails (`is_auto_reply`-Schutz wie bei der Übergabe-Bestätigung).
- Pipeline-Fehler während eines Ausfalls kann das Ziel nicht laden ⇒ heutiges Verhalten (Flip).
