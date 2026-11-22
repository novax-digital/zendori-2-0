# Phase 13 — API-Integration: eigene Endsysteme, Data Actions, 2-Way-Sync

Owner-Entscheidungen 2026-11-20. Stand: **gebaut, Migrationen 0035–0037 seit 2026-11-20 eingespielt**
(siehe „Rollout“).

## Wozu

Ein Zendori-Kunde verbindet seine **eigenen Systeme** (Shop, ERP, Terminbuchung, …) mit Zendori.
Drei Richtungen, die zusammen den Abgleich in beide Richtungen ergeben:

| Richtung | Was | Teilphase |
| --- | --- | --- |
| Agent → Endsystem | **Data Action**: Der KI-Agent ruft im Gespräch einen Endpunkt auf, liest (Bestellstatus) oder schreibt (Termin buchen). | 13a + 13b |
| Zendori → Endsystem | **Ereignisse**: signierter POST, wenn sich Ticket, Konversation oder Kontakt ändern. | 13c |
| Endsystem → Zendori | **Zendori-API**: Ticket-Status/-Felder ändern, Kontakt korrigieren, Notiz anhängen, eigene ID verknüpfen. | 13d |

HubSpot (`integrations`) bleibt unberührt. Alles Neue liegt in eigenen Tabellen und erscheint unter
Einstellungen → Integrationen → „Eigene Endsysteme (API)“.

Seit Phase 14a kann eine Verbindung statt einer REST-API auch ein **MCP-Server** sein; dessen
Werkzeuge werden als Aktionen importiert und laufen über dieselbe Ausführung. Siehe
`docs/phase-14-mcp.md`.

## Begriffe

- **Verbindung** (`api_connections`): ein Endsystem — Basis-URL (nur https), Anmeldung
  (keine | Bearer | Header-Schlüssel | Basic, verschlüsselt), Signatur-Schlüssel, optional
  Ereignis-Adresse + abonnierte Ereignisse.
- **Aktion** (`data_actions`): ein einzelner Aufruf — Methode, Pfad mit `{platzhaltern}`,
  Parameter, freigegebene Antwortfelder, `read|write`, „Mitarbeiter muss bestätigen“.
- **Lauf** (`action_runs`): jede Ausführung mit Auslöser (`agent|test`), Zustand, gesendeten
  Werten, gemapptem Ergebnis, HTTP-Status, Dauer.

## Datenmodell

| Migration | Tabellen / Änderungen |
| --- | --- |
| **0035** | `api_connections`, `data_actions`, `agent_data_actions` (n:m), `action_runs`; Funktionen `request_action_test`, `decide_action_run`; Ticket-Herkunft `action`; `action_runs` in der Realtime-Publication |
| **0036** | `api_connections.event_url/event_types`, `integration_events` (Outbox), Trigger auf `tickets`/`conversations`/`contacts`, `private.origin_connection_id()`, Funktion `request_integration_ping` |
| **0037** | `api_keys`, `external_links`, `api_idempotency_keys`; Guard „Schlüssel sind unveränderlich“; Aufräum-Trigger für Verknüpfungen |

Rechte (RLS): Verbindungen, Schlüssel und Zustellprotokoll liest und schreibt nur Inhaber/Admin.
Aktionen und Läufe lesen alle Mitglieder (Inbox, Agenten-Editor), definieren darf sie nur
Inhaber/Admin. Läufe, Ereignisse und Verknüpfungen schreibt nur der Worker bzw. die API (Service
Role) — die einzigen Client-Einstiege sind die drei SECURITY-DEFINER-Funktionen.

## 13a/13b — Data Actions

### Parameter und Vertrauensgrenze

Jeder Parameter hat einen Ort (`path|query|body`) und eine **Quelle**:

| Quelle | Wer liefert den Wert | Zweck |
| --- | --- | --- |
| `agent` | das Modell, aus dem Gespräch | z. B. Bestellnummer |
| `context` | Zendori, aus der Konversation (`contact.id/name/email/phone`, `conversation.id`, `channel.type`) | Identität — das Modell kann sie **nicht** setzen |
| `fixed` | die Aktionsdefinition | Konstanten |

Das Modell sieht nur `agent`-Parameter (`buildActionToolSchema`). Was es zusätzlich mitschickt, wird
ignoriert (`resolveActionValues`). Pfad-Werte werden als **ein** Segment kodiert, die Anfrage kann
die Basis-URL nie verlassen (`buildActionRequest`). Nur freigegebene Antwortfelder (Punkt-Pfade)
erreichen Modell und Protokoll, gedeckelt auf 4.000 Zeichen.

Hinweis für den Entwurf von Aktionen: Auf Kanälen ohne geprüfte Identität (Chat-Widget) ist
`contact.email` eine Selbstauskunft. Für sensible Auskünfte einen zweiten Faktor verlangen
(z. B. Bestellnummer **und** Postleitzahl).

### Wer führt was aus

| Agent | Lesende Aktion | Schreibende Aktion | Schreibend + „Bestätigung“ |
| --- | --- | --- | --- |
| Text, Autopilot | sofort | sofort | wartet auf Mitarbeiter |
| Text, Nur Entwürfe | sofort | wartet auf Mitarbeiter | wartet auf Mitarbeiter |
| Text/Voice, Reine Annahme | keine Aktionen | — | — |
| Voice, Autopilot | sofort | sofort | wartet → Rückruf-Ticket, Status `pending` |
| Konversation in Mensch-Hand (auch „Entwurf anfordern“) | keine Aktionen | — | — |

„Wartet auf Mitarbeiter“ (Text): Der Lauf steht als `pending_approval` in der Inbox über dem
Entwurf („Ausführen“ / „Verwerfen“). Die Antwort wird **nicht** automatisch gesendet, bleibt
Vorschlag, und es entsteht ein Ticket (Herkunft „Aktion bestätigen“ bei Autopilot, „Entwurf“ bei
Nur-Entwürfe-Agenten). Nach „Ausführen“ setzt die Funktion `decide_action_run` den Lauf auf
`queued`; der Worker ruft das Endsystem auf, das Ergebnis erscheint per Realtime. Den Kunden
informiert danach der Mitarbeiter (bewusst kein automatischer Zweitversand).

### Ausführung (immer im Worker)

`apps/worker/src/actions/execute.ts` ist die einzige Stelle, die ein Endsystem aufruft — für
Agenten, Testläufe und bestätigte Läufe. Damit sieht das Endsystem **eine feste IP** (Hetzner-VPS)
zum Freischalten. Jede Anfrage:

- nur öffentliche Adressen (SSRF-Schutz des Crawlers), **keine** Weiterleitungen, Zeitlimit 1–20 s,
  Antwort max. 256 KiB
- Header `Idempotency-Key` = Lauf-ID; mit Signatur-Schlüssel zusätzlich `webhook-id`,
  `webhook-timestamp`, `webhook-signature` (Standard Webhooks, HMAC-SHA256 über
  `id.timestamp.body`, bei GET über den leeren Body)
- **keine** automatische Wiederholung (ein Schreibzugriff darf nie doppelt ankommen)
- Bremsen: 60 Läufe/Minute pro Org; Text max. 6 Aufrufe in 4 Runden pro Entwurf; Voice max. 20 pro
  Anruf
- Idempotenz pro Kundennachricht (Text): dieselbe Aktion mit denselben Werten wird bei einem
  Pipeline-Retry oder einer Wiederholung durch das Modell nicht erneut gesendet
- ein in `running` hängengebliebener Lauf (Worker-Absturz) wird nach 2 Minuten als fehlgeschlagen
  geschlossen

Text: `draft()` (`packages/ai`) hat eine begrenzte Werkzeug-Schleife; die Regeln A1–A7 im
Draft-Prompt erweitern Regel 1 („nur Wissensquellen“) ausdrücklich um Aktions-Ergebnisse. Voice:
Aktionen sind Function-Tools der Session (`buildActionTool`, `actionToolRules`), die
Latenz-Überbrückung greift auch für sie.

## 13c — Ereignisse

Trigger schreiben pro Änderung und abonnierter Verbindung eine inhaltsfreie Zeile in
`integration_events`; der Worker liest beim Zustellen den **aktuellen** Datensatz und sendet:

```json
{
  "id": "<ereignis-id, gleich dem Header webhook-id>",
  "type": "ticket.updated",
  "created_at": "2026-11-20T10:00:00Z",
  "org_id": "…",
  "changes": { "changed": ["status"], "status_from": "open", "status_to": "resolved" },
  "data": { "ticket": { "id": "…", "display_id": "ZD-2026-0042", "status": "resolved",
    "priority": "normal", "subject": "…", "description": "…", "category": "…",
    "conversation_id": "…", "external_id": "ERP-9001",
    "contact": { "id": "…", "name": "…", "email": "…", "phone": "…", "company": "…" } } }
}
```

| Ereignis | Auslöser |
| --- | --- |
| `ticket.created` | neues Ticket |
| `ticket.updated` | Status, Priorität, Zuweisung, Betreff, Beschreibung oder Kategorie geändert |
| `conversation.created` | neue Konversation |
| `conversation.updated` | Status, Bot/Mensch, Zuweisung oder Kontakt geändert (nicht bei jeder Nachricht) |
| `contact.updated` | Name, E-Mail, Telefon oder Unternehmen geändert |
| `ping` | „Test-Ereignis senden“ |

- **Nachrichtentexte werden nie gesendet** (Owner-Entscheidung: nur Ticketfelder + Kontakt).
- Zustellung **mindestens einmal**: 2xx = zugestellt; sonst bis zu 6 Versuche über ~9 h (1 min,
  5 min, 30 min, 2 h, 6 h), dann „Aufgegeben“. Die Ereignis-ID bleibt über Wiederholungen gleich —
  der Empfänger verwirft Duplikate daran. Der Zeitplan steht in der Zeile (`next_attempt_at`), ein
  Lease verhindert Doppelzustellung; pg-boss führt nur den einzelnen Versuch aus.
- **Kein Echo:** Änderungen, die über die Zendori-API von Verbindung X kommen, werden nicht an X
  gemeldet. Die API-Route markiert ihre Service-Role-Anfragen mit dem Header
  `x-zendori-origin-connection`; nur die Service Role darf das (ein Mitarbeiter kann damit kein
  Ereignis unterdrücken).
- Ein Fehler in der Outbox bricht nie einen Kern-Schreibzugriff ab (die Trigger-Funktion schluckt
  eigene Fehler: lieber ein Ereignis verlieren als eine Nachricht).
- Zugestellte/aufgegebene Ereignisse werden nach 30 Tagen gelöscht.

## 13d — Zendori-API (`/api/v1`)

Anmeldung: `Authorization: Bearer zk_live_…`. Ein Schlüssel gehört zu genau einer Verbindung;
gespeichert wird nur sein SHA-256, angezeigt wird er einmal. Limits: 300 Anfragen/min pro IP (vor
der Schlüsselprüfung), 120/min pro Schlüssel. Body max. 64 KiB.

| Aufruf | Wirkung |
| --- | --- |
| `GET /me` | Schlüssel prüfen |
| `GET /tickets/{ref}` | Ticket mit Kontakt (ohne Nachrichtentexte) |
| `PATCH /tickets/{ref}` | `status` (`open\|in_progress\|waiting\|resolved`), `priority`, `category` |
| `POST /tickets/{ref}/notes` | interne Notiz `{"content"}`; Header `Idempotency-Key` macht Wiederholungen sicher |
| `GET /conversations/{ref}` | Status, Kanal, Kontakt |
| `POST /conversations/{ref}/notes` | interne Notiz |
| `GET /contacts/{ref}` · `PATCH /contacts/{ref}` | `name`, `email`, `phone`, `company` |
| `PUT /links` | eigene ID verknüpfen: `{"entity_type","entity_id","external_id"}` |

`{ref}` = Zendori-ID oder `ext:<eigene ID>` (nach `PUT /links`; URL-kodieren). Antworten:
`{"data":{…}}`, Fehler `{"error":{"code","message"}}` mit 401/403/404/409/422/429/500. Unbekannte
Felder im Body werden abgelehnt (422), nicht ignoriert.

Bewusst **nicht** möglich: Konversationen oder Nachrichten anlegen (§2: kein dritter Intake-Weg),
Betreff/Beschreibung eines Tickets ändern, Nachrichtentexte lesen. Notizen sind intern, tragen den
Namen der Verbindung (`[ERP] …`) und gehen nie an den Kunden.

## Code-Landkarte

| Bereich | Ort |
| --- | --- |
| Schemas, Werte, Request-Bau, Antwort-Mapping | `packages/core/src/data-actions.ts` |
| Ereignis-Katalog, Retry-Plan | `packages/core/src/integration-events.ts` |
| API-Schlüssel, API-Fachlogik | `packages/core/src/api-keys.ts`, `public-api.ts` |
| HTTP-Client (Auth, Signatur, Limits) | `packages/integrations/src/custom-api/client.ts` |
| Ausführung, Läufe, Warteschlange | `apps/worker/src/actions/execute.ts` |
| Ereignis-Zustellung | `apps/worker/src/actions/events.ts` |
| Text-Anbindung | `apps/worker/src/pipeline/draft-actions.ts`, `process-message.ts`, `packages/ai/src/anthropic.ts` |
| Voice-Anbindung | `apps/worker/src/voice/action-tool.ts`, `session-config.ts`, `call-session.ts`, `dispatch.ts` |
| Einstellungen | `apps/web/src/app/settings/integrations/api/…` |
| Inbox-Bestätigung | `apps/web/src/components/inbox/ActionRuns.tsx`, `app/inbox/action-runs.ts` |
| API-Routen | `apps/web/src/app/api/v1/…`, `lib/public-api/handler.ts` |

## Sicherheit & DSGVO

- Zugangsdaten nur als libsodium-Chiffrat in `api_connections.config`; nie im Log, nie im Client.
  Einzige Ausnahme: Der Signatur-Schlüssel ist für Inhaber/Admin auf Wunsch einsehbar (das
  Endsystem braucht ihn zum Prüfen).
- Keine Inhalte in Logs: Logs tragen IDs, Status, Dauer. Gesendete Werte und gemappte Antworten
  stehen in `action_runs` (RLS, org-gebunden).
- Das Endsystem gehört dem Kunden — er ist verantwortlich für dessen Standort. Zendori sendet
  dorthin nur, was die Aktion/das Ereignis definiert.
- `org.purge`-Checkliste: alle neuen Tabellen hängen per `on delete cascade` an der Organisation
  (`api_connections`, `data_actions`, `agent_data_actions`, `action_runs`, `integration_events`,
  `api_keys`, `external_links`, `api_idempotency_keys`).

## Rollout

Reihenfolge wie bei 0019/0030: **App zuerst, dann Migration.** Web und Worker tolerieren die
fehlenden Tabellen/Spalten (Oberfläche zeigt „Migration steht aus“, Worker-Scan bleibt still).

1. Web deployen (Push auf `main`), Worker-Image bauen und auf dem VPS ziehen.
2. Migrationen in Reihenfolge anwenden: `0035` → `0036` → `0037` (psql + `DATABASE_URL_SESSION`,
   Ledger nachtragen). 13a/13b brauchen nur 0035.
3. Keine neuen Env-Variablen. Der Worker braucht `MASTER_ENCRYPTION_KEY` (vorhanden); die API-Limits
   nutzen die vorhandenen Upstash-Variablen.
4. Feste Worker-IP an Kunden weitergeben, die eine IP-Freigabe brauchen.

Geprüft ohne Produktivdatenbank: Die drei Migrationen wurden gegen eine lokale Postgres-17-Instanz
mit nachgebauten Abhängigkeiten angewendet; Rechte, Funktionen, Trigger und Echo-Unterdrückung
liefen dort als SQL-Prüfungen durch. Gegen die echte Supabase-Instanz ist noch nichts gelaufen —
die Oberfläche und die HTTP-Routen sind per Typecheck, Lint und Produktions-Build geprüft, nicht
per Klick.

## Manuelle Testanleitung

Voraussetzung: Migrationen angewendet, Worker in aktueller Version. Als Gegenstelle genügt ein
Request-Sammler (z. B. webhook.site) oder ein eigener Test-Endpunkt.

**A — Verbindung und Aktion (13a)**

1. Einstellungen → Integrationen → „Neue Verbindung“: Name, `https://…`, Anmeldung „Bearer-Token“.
   Erwartet: Detailseite mit Reiter „Verbindung“.
2. „Schlüssel anzeigen“ unter Signatur. Erwartet: `whsec_…`; „Neuen Schlüssel erzeugen“ ersetzt ihn.
3. Reiter „Aktionen“ → „Neue Aktion“: Bezeichnung „Bestellstatus abfragen“, Name
   `bestellstatus_abfragen`, GET, Pfad `/orders/{order_id}`, Parameter `order_id` (Pfad, KI-Agent)
   und `email` (Query, Kontext → E-Mail des Kontakts), Antwortfeld `status`. Speichern.
   Erwartet: „Aktion gespeichert.“ Gegenprobe: Pfad `/orders/{nummer}` ohne passenden Parameter →
   verständliche Fehlermeldung.
4. „Testlauf starten“ mit `order_id=4711`, `email=test@example.com`. Erwartet: binnen Sekunden
   „Erfolgreich“, HTTP-Status, Dauer, nur das Feld `status`. Die Gegenstelle zeigt
   `Authorization`, `Idempotency-Key` und die drei `webhook-*`-Header.
5. Basis-URL auf eine interne Adresse stellen (`https://10.0.0.1`) → Testlauf: „Die Adresse ist
   nicht öffentlich erreichbar“.

**B — Agent (13b)**

6. Agent öffnen → Reiter „Aktionen“ → Aktion anhaken → speichern.
7. Text, Autopilot: Im Chat-Widget „Wo ist meine Bestellung 4711?“ schreiben. Erwartet: Antwort
   nennt den Status; in der Inbox unter „Aktionen des Agenten (1)“ der Lauf; an der Gegenstelle
   die E-Mail des **Kontakts**, nicht eine vom Kunden behauptete.
8. Schreibende Aktion mit „Mitarbeiter muss bestätigen“ anlegen und verknüpfen, im Chat auslösen.
   Erwartet: keine automatische Antwort, Entwurf als Vorschlag, Block „Wartet auf Bestätigung“ mit
   den Werten, Ticket mit Herkunft „Aktion bestätigen“. „Ausführen“ → Lauf wird „Erfolgreich“, an
   der Gegenstelle genau **ein** Aufruf. „Verwerfen“ an einem zweiten Lauf → kein Aufruf.
9. Agent auf „Nur Entwürfe“: schreibende Aktion ohne Bestätigungs-Schalter auslösen. Erwartet:
   wartet trotzdem auf Bestätigung.
10. Voice (Autopilot-Agent mit der Lese-Aktion): anrufen, Bestellnummer nennen. Erwartet: Agent
    fasst das Ergebnis zusammen; bei längerer Antwortzeit ein Überbrückungssatz.

**C — Ereignisse (13c)**

11. Reiter „Ereignisse“: Adresse eintragen, „Ticket geändert“ anhaken, speichern, „Test-Ereignis
    senden“. Erwartet: im Zustellprotokoll „Zugestellt“, an der Gegenstelle `type: "ping"`.
12. Ein Ticket auf „Erledigt“ stellen. Erwartet: Ereignis `ticket.updated` mit
    `changes.status_to = "resolved"` und dem Ticket samt Kontakt, ohne Nachrichtentexte.
13. Gegenstelle antwortet mit 500. Erwartet: „Ausstehend“, Versuche 1, nächster Versuch nach ~1 min.

**D — Zendori-API (13d)**

14. Reiter „API-Schlüssel“ → Schlüssel anlegen. Erwartet: Schlüssel einmal sichtbar, danach nur
    noch der Anfang in der Liste.
15. `curl -H "Authorization: Bearer <KEY>" <APP_URL>/api/v1/me` → `200` mit Org und Verbindung;
    ohne Schlüssel → `401`.
16. `curl -X PUT …/api/v1/links -d '{"entity_type":"ticket","entity_id":"<ticket-id>","external_id":"ERP-1"}'`
    → `201`; danach `curl -X PATCH …/api/v1/tickets/ext:ERP-1 -d '{"status":"waiting"}'` → `200`,
    Ticket in Zendori „Wartet“.
17. **Kein Echo:** Nach Schritt 16 erscheint im Zustellprotokoll **dieser** Verbindung kein
    `ticket.updated`. Dieselbe Änderung in der Zendori-Oberfläche erzeugt eines.
18. `curl -X POST …/tickets/ext:ERP-1/notes -H "Idempotency-Key: a1" -d '{"content":"Teil bestellt"}'`
    zweimal → beide `201` mit derselben Notiz-ID, im Ticket genau **eine** Notiz „[Name] Teil bestellt“.
19. Schlüssel widerrufen → nächster Aufruf `401`.

## Offene Punkte

- Aktionen werden gezählt (`action_runs`), nicht bepreist.
- Keine Listen-Endpunkte (`GET /tickets?…`) — bei Bedarf für Abgleichläufe nachziehen.
- Nach einer bestätigten Aktion informiert der Mitarbeiter den Kunden; ein automatischer
  Folgeversand ist nicht gebaut.
- RLS-Tests für 0035–0037 stehen in `packages/core/test/rls.test.ts`, laufen aber nur mit lokaler
  Supabase-Instanz (`ZENDORI_TEST_SUPABASE_*`).
