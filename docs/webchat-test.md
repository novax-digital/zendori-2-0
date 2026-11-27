# Chat testen: Reiter „Test“ am Chat-Kanal (Migration 0050)

Owner-Wunsch 2026-11-27: „Test“ aus „Neuer Kanal“ herausnehmen. Dafür bekommt der Chat-Kanal einen
Reiter „Test“, in dem man den Webchat wirklich für sich ausprobieren kann — auch wenn der Kanal
noch ein Entwurf ist und der Agent nur Entwürfe schreibt.

Stand: **Migration 0050 ist seit 2026-11-27 eingespielt** (Probelauf mit Rollback auf Produktion,
dann echt; über die API geprüft: 154 Konversationen, keine davon ein Testgespräch). Der Reiter
arbeitet vollständig, sobald Web **und Worker** auf dem neuen Stand laufen. Mit einem älteren Worker
antwortet der Test nur bei einem aktiven Agenten auf „Autopilot“, und ein Testgespräch könnte bei
einer HubSpot-Regel „alle Konversationen“ noch zu HubSpot gehen — Tickets entstehen auch dann nicht
(die Datenbank weist sie ab).

## Was es kann

**Einstellungen → Kanäle → Chat-Kanal → Reiter „Test“.** Rechts läuft das echte Chat-Fenster des
Kanals in einem Rahmen: dasselbe Script, dasselbe Design, derselbe Agent wie später auf der Website.
Man schreibt hinein wie ein Besucher.

- **Geht auch als Entwurf.** Ein inaktiver Kanal ist auf der Website nicht erreichbar, im Reiter
  „Test“ antwortet er trotzdem.
- **Der Agent antwortet direkt**, auch wenn er pausiert ist oder im Betrieb nur Entwürfe schreibt.
  Sonst gilt alles wie im Betrieb: Sicherheits-Schwelle, Übergabe-Regeln, Eskalations-Keywords,
  Wissensdatenbanken. „Reine Annahme“ bleibt Reine Annahme.
- **„Neues Testgespräch“** beginnt von vorn (neue Konversation, Begrüßung und Kontaktabfrage
  erscheinen wieder).
- Links steht, was gerade gilt: Kanal ist Entwurf, kein Agent zugewiesen, Agent pausiert, Agent
  schreibt nur Entwürfe, Agent nimmt nur an.

Sehen kann den Reiter, wer Kanäle sehen darf. Mitarbeiter mit eingeschränkten Kanälen können nur
Kanäle testen, die zu ihrem Zugang gehören.

### Was ein Testgespräch ist

Eine Konversation aus dem Reiter „Test“ trägt das Kennzeichen `conversations.is_test`. Sie steht
in der Inbox wie jede andere, mit dem Zeichen **„Test“** — man kann dort als Mitarbeiter antworten,
übernehmen und an den Bot zurückgeben; die Antwort erscheint im Test-Chat.

| | echte Konversation | Testgespräch |
| --- | --- | --- |
| Inbox, Antworten, Übernehmen, Notizen | ja | ja |
| KI-Antwort | je nach Agent | immer direkt, wenn die Antwort sicher genug ist |
| Ticket | ja, je nach Fall | **nie** (auch nicht über „Ticket anlegen“) |
| E-Mail-Benachrichtigung ans Team | ja | **nie** |
| Ereignis an ein angebundenes Endsystem | ja | **nie** |
| HubSpot | je nach Regel | **nie** |
| Lern-Schleife (Antwort wird Wissen) | ja | **nie** |
| Verbrauch (KI-Vorgänge) | zählt | zählt genauso |
| Data Actions, lesend | laufen | laufen |
| Data Actions, schreibend | je nach Einstellung von selbst | **nie von selbst** — sie warten in der Inbox auf „Ausführen“ |

Übergibt der Agent an einen Menschen, wartet das Testgespräch in der Inbox wie ein echtes (Status
„Wartend“, Modus „Mensch“), der Kunde im Test sieht den eingestellten Übergabe-Text. Ist das
Eskalationsziel des Agenten „Ticket“, erscheint im Test die Ticket-Bestätigung mit **„TEST“**
anstelle der Ticketnummer — ein Ticket entsteht nicht.

### Was sich sonst ändert

- **„Neuer Kanal“** bietet „Test“ nicht mehr an. Vorhandene Test-Kanäle bleiben und funktionieren
  weiter, ebenso der Knopf „Testnachricht“ (Nachricht von Hand in einen aktiven Kanal einspeisen —
  damit lassen sich auch E-Mail-Kanäle prüfen).
- **„Widget-Demo“** gibt es nicht mehr als eigene Seite. Die Demo erzeugte echte Konversationen samt
  Tickets und Benachrichtigungen und ging nur mit aktivem Kanal. Alte Links führen in den Reiter
  „Test“ des ersten Chat-Kanals.
- **Kontaktangabe im Chat mit bekannter E-Mail-Adresse** (Fehler behoben, betrifft auch echte
  Besucher): Gab ein Besucher eine Adresse an, die im Unternehmen schon zu einem Kontakt gehört,
  schlug das Speichern fehl („Speichern hat leider nicht geklappt“) — typisch für wiederkehrende
  Besucher in einem neuen Browser, und im Test bei jedem zweiten Testgespräch. Jetzt wird der Name
  gespeichert und die Adresse als **interne Notiz** an der Konversation abgelegt. Zusammengeführt
  wird bewusst nichts: Im Chat ist eine Adresse nur behauptet, die Antworten gehen in den Browser
  und nicht in das Postfach. Wer eine fremde Adresse eintippt, darf damit nicht den bestehenden
  Kontakt übernehmen (und das, was eine Data Action für ihn nachschlägt). Nebenbei verrät die
  Antwort nicht mehr, ob eine Adresse bekannt ist.

## Technik

```
Reiter „Test“ ──Rahmen──▶ /widget-test?org=…&channel=…   (nur angemeldete Mitglieder)
                              └─ <script src="/widget.js" data-zendori-token="…" data-zendori-test>
                                     │  jede Anfrage trägt test: true (+ Sitzungs-Cookie)
                                     ▼
                         /api/widget/bootstrap | session | message
                              └─ Testmodus: Mitglied der Organisation mit Zugriff auf den Kanal?
                                   ja  → Kanal auch als Entwurf, Konversation is_test = true
                                   nein → Antwort wie bei unbekanntem Token (404)
```

- **Migration 0050** (`supabase/migrations/0050_test_conversations.sql`): Spalte
  `conversations.is_test` (Standard `false`). Die Auslöser für Benachrichtigungen (0038) und
  Ereignisse (0036) überspringen Testgespräche; ein Kontakt, der nur zu Testgesprächen gehört,
  meldet keine Änderung. Ein Auslöser auf `tickets` weist Tickets für Testgespräche ab (SQLSTATE
  `ZT001`), bevor eine Nummer vergeben wird.
- **Widget** (`apps/web/src/widget`): `data-zendori-test` setzt `test: true` in allen Anfragen,
  hält die Sitzung unter eigenen Schlüsseln (`zendori-widget-test-<token>`, getrennt von einer
  echten Besucher-Sitzung im selben Browser) und öffnet den Chat sofort. Auf einer Kundenwebsite
  bewirkt das Attribut nur, dass das Widget unsichtbar bleibt.
- **Widget-API** (`apps/web/src/lib/widget/test-mode.ts`): Im Testmodus wird der Kanal auch inaktiv
  gefunden — aber nur für ein angemeldetes Mitglied der Organisation, das Kanäle sehen darf und
  Zugriff auf diesen Kanal hat. Anfragen von fremden Websites tragen kein Cookie (die Widget-API
  erlaubt jede Herkunft, aber nie Anmeldedaten). Der Testmodus setzt nur eigene Testgespräche fort
  und schreibt nie in eine echte Konversation. Der öffentliche Weg ist unverändert.
- **Rahmen statt Einbau in die Seite:** Das Widget hängt sich an `document.body` und bleibt dort.
  Im Rahmen verschwindet es mit dem Reiter.
- **Worker** (`apps/worker/src/pipeline/process-message.ts`): Bei `is_test` gilt der zugewiesene
  Agent als aktiv, die Antwort wird gesendet statt nur vorgeschlagen, es entsteht kein Ticket und
  keine HubSpot-Anfrage. Schreibende Data Actions werden wie bei einem Agenten im Modus „Nur
  Entwürfe“ vorbereitet: Sie warten auf eine Bestätigung, die Antwort bleibt dann Vorschlag. `ensureTicket()` (packages/core) gibt für Testgespräche `skipped` zurück;
  `syncConversation` (HubSpot) und die Lern-Schleife lassen Testgespräche aus.
- **Reihenfolge beim Ausrollen:** Migration zuerst. Der laufende Code kennt die Spalte nicht und
  verhält sich wie bisher. Der neue Code verträgt auch die alte Datenbank (der Reiter meldet dann,
  dass der Test noch nicht freigeschaltet ist; Nachrichten werden wie bisher verarbeitet).
- **Verbrauch:** Testgespräche zählen wie jede Konversation. Die Regel „in der Testphase kostenlos
  mit Tageslimit, danach normaler Verbrauch“ (Owner 2026-11-27) kommt mit der Selbst-Anmeldung — die
  Testphase gibt es erst dort.

## Geprüft

- `pnpm typecheck`, `pnpm lint`, `pnpm test` grün; `next build` ok.
- **Pipeline** (`apps/worker/test/pipeline-test-conversation.test.ts`, 18 Tests): Agent im Modus
  „Nur Entwürfe“ und pausierter Agent antworten im Test; unsichere Antwort wird übergeben statt
  gesendet; kein Agent → keine Antwort; in fünf Fällen kein Ticket und keine HubSpot-Anfrage;
  Ticket-Bestätigung mit „TEST“, einmal je Gespräch; schreibende Data Actions warten; echte
  Konversationen unverändert, auch mit einem Worker, der vor der Migration läuft.
- **HubSpot und Lern-Schleife** (`test-conversation-side-effects.test.ts`, 4 Tests), **Ticket-Sperre**
  (`packages/core/test/ticket-service.test.ts`, `test-conversations.test.ts`, 9 Tests).
- **Migration** gegen eine lokale Postgres mit den echten Migrationen 0036 und 0038: 27 Prüfungen —
  echte Konversation benachrichtigt und meldet wie bisher, Testgespräch nie; Kontakt nur an
  Testgesprächen meldet nichts, Kontakt an einem echten schon; Ticket für ein Testgespräch wird
  abgewiesen, der Nummernkreis läuft ohne Lücke weiter.
- **Widget-API**: die echten Routen (`next dev`) gegen eine nachgebaute Datenbank-Schnittstelle, 38
  Prüfungen — ein Entwurf antwortet nur einem angemeldeten Mitglied mit Zugriff (nicht: Besucher,
  Besucher mit `test: true`, Fremder, Mitglied einer anderen Organisation, Mitarbeiter ohne diesen
  Kanal, Mitglied ohne Testmodus); nur dort entsteht ein Testgespräch; der Testmodus schreibt nicht
  in echte Konversationen; der Weg für Besucher ist unverändert.
- **Seiten** über dieselbe Schnittstelle: Reiter „Test“ mit allen Hinweisen, Rahmen-Seite,
  „Neuer Kanal“ ohne „Test“, alter Widget-Demo-Link. Bildschirmfoto des Reiters mit laufendem Chat.
- **Widget im Browser** (gebaute `widget.js`, Chrome ohne Fenster): Testmodus sendet `test: true`
  und setzt die Test-Sitzung fort, das Widget ohne Attribut ist unverändert.

- **Produktion:** Probelauf der Migration in einer zurückgerollten Transaktion mit denselben
  Prüfungen (Benachrichtigungen, Ereignisse, Kontakte, Ticket-Sperre, auch als Inhaber über die
  API-Rolle); die ersetzten Funktionen waren vorher bytegleich mit den Migrationen 0036 und 0038.

**Nicht geprüft:** der ganze Weg im Browser mit echter KI-Antwort — dafür braucht es eine Anmeldung
und den neuen Worker (Testanleitung unten).

## Testanleitung

Voraussetzung: Migration 0050 eingespielt, Web deployt, Worker auf dem neuen Stand.

1. Einstellungen → Kanäle → **„Neuer Kanal“**. **Erwartet:** „Test“ steht nicht mehr in der Liste.
2. Einen Chat-Kanal öffnen, der **inaktiv** ist (oder einen neuen anlegen und deaktivieren) und dem
   ein Agent im Modus **„Nur Entwürfe“** zugewiesen ist. Reiter **„Test“**. **Erwartet:** rechts das
   geöffnete Chat-Fenster im Design des Kanals; links die Hinweise „Der Kanal ist noch ein Entwurf“
   und „… schreibt im Betrieb nur Entwürfe“.
3. Eine Frage schreiben, die die Wissensdatenbank beantwortet. **Erwartet:** nach einigen Sekunden
   antwortet der Agent im Chat.
4. **Inbox** öffnen (Knopf „Gespräche dieses Kanals in der Inbox“). **Erwartet:** das Gespräch mit
   dem Zeichen **„Test“**; in der Seitenleiste statt „Ticket anlegen“ der Hinweis, dass für
   Testgespräche keine Tickets angelegt werden; kein HubSpot-Abschnitt.
5. **Tickets** öffnen. **Erwartet:** kein neues Ticket. Im Postfach: keine Benachrichtigung.
6. In der Inbox **„Übernehmen“** und antworten. **Erwartet:** die Antwort erscheint im Test-Chat,
   ohne neu zu laden. „An Bot zurückgeben“, wieder im Chat schreiben. **Erwartet:** der Agent
   antwortet wieder.
7. Im Chat „Ich möchte mit einem Menschen sprechen“ schreiben. **Erwartet:** das Gespräch steht in
   der Inbox auf „Wartend“ / „Mensch“, im Chat erscheint der Übergabe-Text (falls eingestellt), kein
   Ticket.
8. **„Neues Testgespräch“**. **Erwartet:** leerer Chat mit Begrüßung; nach der ersten Nachricht ein
   zweites Gespräch in der Inbox.
9. Kontaktabfrage im Chat ausfüllen, in einem zweiten Testgespräch **dieselbe E-Mail-Adresse**
   angeben. **Erwartet:** beide Male „gespeichert“; am zweiten Gespräch steht eine interne Notiz mit
   der Adresse.
10. Den Embed-Code des **inaktiven** Kanals in eine beliebige HTML-Seite setzen (oder die Website
    öffnen). **Erwartet:** kein Chat-Button — der Entwurf ist nur im Reiter „Test“ erreichbar.
11. Den Kanal aktivieren und den echten Chat auf der Website benutzen. **Erwartet:** eine normale
    Konversation ohne „Test“, mit Ticket und Benachrichtigung wie bisher; der Agent im Modus „Nur
    Entwürfe“ antwortet dort **nicht** direkt.
12. Einen alten Link `/widget-demo` öffnen. **Erwartet:** Weiterleitung in den Reiter „Test“.
