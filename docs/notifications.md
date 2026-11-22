# E-Mail-Benachrichtigungen für Mitarbeiter

Stand: gebaut und gepusht; Migration `0038_member_notifications.sql` ist **seit 2026-11-22
eingespielt** (Versand braucht den Worker ab Tag `6d68a5d`).

## Wozu

Jedes Teammitglied legt unter **Einstellungen → Benachrichtigungen** selbst fest, zu welchen
Ereignissen es eine E-Mail bekommt. Die Auswahl ist persönlich und gilt pro Organisation. Ohne
Auswahl kommt nichts (Opt-in) — nach dem Deploy bekommt also niemand ungefragt Post.

## Ereignisse

| Schlüssel          | Name in der Oberfläche     | Wann                                                                    | Wer                              |
| ------------------ | -------------------------- | ----------------------------------------------------------------------- | -------------------------------- |
| `conversation.new` | Neue Konversation          | Eine Konversation wurde angelegt und ihre erste Nachricht ist kein Spam | alle, die es eingeschaltet haben |
| `ticket.new`       | Neues Ticket               | Ein Ticket wurde angelegt (Agent, Formular, Voice, von Hand)            | alle, die es eingeschaltet haben |
| `handoff.pending`  | Übergabe an einen Menschen | Der KI-Agent hat übergeben, die Konversation wartet                     | alle, die es eingeschaltet haben |
| `assigned`         | Mir zugewiesen             | Eine Konversation oder ein Ticket wurde zugewiesen                      | nur die zugewiesene Person       |

Definitionen: `packages/core/src/notifications.ts` (`NOTIFICATION_EVENTS`, `NOTIFICATION_EVENT_DEFS`).

Bewusst nicht dabei (möglicher Ausbau): „neue Kundenantwort in einer mir zugewiesenen
Konversation“ — bräuchte eine Bündelung, sonst erzeugt jeder Chat-Satz eine E-Mail.

## Regeln

- **Zugriff:** Eine E-Mail geht nur raus, wenn das Mitglied den Datensatz in der App sehen dürfte —
  Bereich (`inbox` für Konversationen, `tickets` für Tickets) und bei eingeschränkten Mitarbeitern
  der Kanal. Geprüft wird beim Versand, nicht beim Auslösen (`canReceiveNotification`).
- **Eigene Aktionen:** Wer etwas selbst auslöst (Ticket von Hand anlegen, sich selbst zuweisen),
  bekommt dazu keine E-Mail.
- **Spam:** „Neue Konversation“ wartet, bis die KI-Pipeline die erste Nachricht geprüft hat
  (höchstens 10 Minuten). Spam und automatische Antworten lösen nichts aus.
- **Keine Doppelpost:** „Neu“ und „Mir zugewiesen“ für denselben Datensatz ergeben eine E-Mail
  (die Zuweisung).
- **Übergabe:** nur Übergaben, nach denen eine Konversation auf einen Menschen wartet
  (`pending_human`, `transfer_failed`). Nicht bei „Übernehmen“ von Hand, nicht bei unterdrückter
  Übergabe, nicht bei erfolgreichem Anruf-Transfer. Rückruf-Tickets melden sich als „Neues Ticket“.
- **Inhalt:** Betreff, Kontaktname, Kanal, Ticket-Nummer, Zeitpunkt und ein Link in die App.
  **Keine Nachrichtentexte.**
- **Empfänger:** die Anmelde-Adresse des Mitglieds. Absender ist `RESEND_FROM`.

## Datenmodell (0038)

- `notification_preferences` (org_id, user_id, events text[]) — eine Zeile pro Mitglied und
  Organisation. RLS: jedes Mitglied liest und schreibt **nur die eigene Zeile**; auch Inhaber und
  Admins sehen die Auswahl anderer nicht. Verlässt jemand die Organisation, fällt die Zeile weg.
- `member_notifications` (org_id, user_id, event_type, entity_type, entity_id, actor_id, details,
  state `pending|sent|skipped|failed`, attempts, next_attempt_at, last_error) — die Warteschlange,
  eine Zeile pro Ereignis und Empfänger. Inhaltsfrei (nur IDs, bei Übergaben der Grund). RLS ohne
  Policies: nur Trigger und Worker. Der Worker löscht Zeilen nach 30 Tagen.
- Trigger auf `conversations` (Insert, Zuweisung), `tickets` (Insert, Zuweisung) und
  `handoff_events` (Insert) füllen die Warteschlange — damit sind alle Schreibwege abgedeckt
  (Web, Worker, Zendori-API). Die Schreibfunktion schluckt eigene Fehler: Ein Problem mit der
  Warteschlange lässt nie einen Konversations- oder Ticket-Schreibvorgang scheitern.

## Ablauf

```
Trigger → member_notifications (pending)
Worker-Scan (1 s) → Job member.notify → deliverMemberNotification:
  noch Mitglied? noch abonniert? Datensatz da? Zugriff? Doppelt? Spam-Prüfung (nur conversation.new)
  → Vorlage rendern → Resend → sent
  → nicht zustellbar: Wiederholung nach 1 min, 5 min, 30 min, dann failed
  → nicht gewollt/erlaubt: skipped (mit Grund in last_error)
```

Code:

- Versand: `apps/worker/src/notifications/deliver.ts`, eingehängt in `scan.ts` und `index.ts`
- Vorlagen: `packages/channels/src/notifications/member-email.ts` (eine pro Ereignis) auf dem
  Zendori-Maillayout `packages/channels/src/email/brand-mail.ts` (aus `apps/web` dorthin verschoben,
  damit Web und Worker dasselbe Layout nutzen; Einladung und Passwort-Mail sind unverändert)
- Oberfläche: `apps/web/src/app/settings/notifications/` (Seite + Aktionen)

## Testmail

Auf der Seite hat jedes Ereignis den Knopf **„Testmail senden“**. Er schickt die Vorlage mit
Beispieldaten an die eigene Anmelde-Adresse, markiert als Test (Betreff `[Test] …`, Hinweis im
Text). Die Testmail geht direkt aus der Web-App über Resend (eine einzelne Mail, höchstens 6 in
10 Minuten pro Person) und funktioniert auch, bevor die Migration eingespielt ist.

## Rollout

1. Web deployen (Push auf `main`), Worker-Image auf dem VPS ziehen. Web und Worker kommen ohne die
   neuen Tabellen zurecht (Seite zeigt „Migration steht aus“, Worker-Scan bleibt still).
2. Migration `0038` anwenden (psql + `DATABASE_URL_SESSION`, Ledger nachtragen).
3. Keine neuen Env-Variablen. Der Worker braucht `RESEND_API_KEY`, `RESEND_FROM` und `APP_URL`
   (für die Links; ohne `APP_URL` zeigt der Link auf `https://app.zendori.ai`).

Geprüft ohne Produktivdatenbank: Die Migration lief gegen eine lokale Postgres-17-Instanz mit
nachgebauten Abhängigkeiten; Rechte, Trigger, Ausschluss der eigenen Aktion und das Verhalten bei
kaputter Warteschlange liefen dort als SQL-Prüfungen durch.

## Manuelle Testanleitung

Voraussetzung: Web deployt. Schritte 1–3 gehen ohne Migration, ab 4 mit Migration 0038 und
aktuellem Worker.

1. Einstellungen → **Benachrichtigungen** öffnen.
   _Erwartet:_ Seite mit vier Ereignissen, darüber deine Anmelde-Adresse. Ohne Migration zusätzlich
   der Hinweis „Migration 0038 ausstehend“ und ausgegraute Kästchen.
2. Bei „Neues Ticket“ auf **Testmail senden** klicken.
   _Erwartet:_ Meldung „Testmail „Neues Ticket“ an … gesendet.“ Im Postfach: Betreff
   `[Test] Neues Ticket T-1042: Rückfrage zur Lieferung`, oranger Testhinweis, Tabelle mit Ticket,
   Betreff, Kontakt, Kanal, Zeitpunkt, Knopf „Ticket in Zendori öffnen“.
3. Testmail für die anderen drei Ereignisse senden.
   _Erwartet:_ je eine Mail mit eigenem Betreff („Neue Konversation: …“, „Wartet auf einen
   Mitarbeiter: …“, „Ihnen zugewiesen: Ticket T-1042 — …“).
4. (Mit Migration) „Neue Konversation“ und „Neues Ticket“ anhaken, **Speichern**.
   _Erwartet:_ „Benachrichtigungen gespeichert.“ Nach Neuladen sind die Haken gesetzt.
5. Über den Test-Kanal oder das Chat-Widget eine neue Konversation mit normalem Text anlegen.
   _Erwartet:_ Nach etwa 20–40 Sekunden eine Mail „Neue Konversation: …“ mit Link in den
   Posteingang. Der Nachrichtentext steht nicht in der Mail.
6. Eine offensichtliche Spam-Nachricht als neue Konversation einspeisen.
   _Erwartet:_ keine Mail.
7. In einer Konversation von Hand ein Ticket anlegen.
   _Erwartet:_ **keine** Mail an dich (eigene Aktion). Ein Kollege mit „Neues Ticket“ bekommt eine.
8. Einen Agenten im Autopilot zu einer Übergabe bringen (z. B. „Ich möchte einen Menschen
   sprechen“) — vorher „Übergabe an einen Menschen“ einschalten.
   _Erwartet:_ Mail „Wartet auf einen Mitarbeiter: …“ mit dem Grund.
9. Mit einem zweiten Konto: „Mir zugewiesen“ einschalten; mit dem ersten Konto diesem Konto ein
   Ticket zuweisen.
   _Erwartet:_ Das zweite Konto bekommt „Ihnen zugewiesen: Ticket …“. Weist es sich selbst etwas
   zu, kommt nichts.
10. Einem Mitarbeiter nur einen Kanal freigeben, „Neue Konversation“ einschalten, dann eine
    Konversation in einem anderen Kanal anlegen.
    _Erwartet:_ keine Mail an diesen Mitarbeiter.
11. Alle Haken entfernen, **Speichern**.
    _Erwartet:_ „Gespeichert — du bekommst keine E-Mail-Benachrichtigungen.“ Neue Ereignisse lösen
    nichts mehr aus.

## Offene Punkte

- „Neue Kundenantwort in einer mir zugewiesenen Konversation“ (mit Bündelung) ist nicht gebaut.
- Vorlagen sind fest im Code, nicht pro Organisation anpassbar.
- Kein Sammel-Versand (Digest): jedes Ereignis ist eine E-Mail.
