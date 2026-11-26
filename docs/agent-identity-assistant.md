# KI-Vorschlag für die Identität eines Agenten (Migration 0049)

Owner-Wunsch 2026-11-26: Beim Identitäts-Prompt eines Agenten soll man sich den Text von einer KI
schreiben lassen können, wenn man ein paar Stichpunkte eingibt.

Stand: **Migration 0049 ist seit 2026-11-26 eingespielt** (Probelauf mit Rollback, dann echt; über
die API geprüft, ohne eine Anfrage anzulegen). Der Knopf arbeitet, sobald der **Worker** auf dem
neuen Stand läuft.

## Was es kann

**Einstellungen → KI-Agenten → Agent → Reiter „Identität“** (und im Fenster „Neuer Agent“): unter
dem Feld „Identität (System-Prompt)“ steht **„Mit KI erstellen“**.

1. Stichpunkte eintippen, z. B. „Kundenservice für unseren Onlineshop für Solaranlagen. Kunden
   duzen, kurz und freundlich. Keine Preise oder Liefertermine zusagen, bei Reklamationen an das
   Team verweisen.“
2. Steht im Feld schon ein Text, kann er als Grundlage dienen („Den vorhandenen Text als Grundlage
   nehmen und überarbeiten“, vorausgewählt).
3. **„Vorschlag erstellen“** — nach etwa 10 Sekunden erscheint der Vorschlag.
4. **„Übernehmen“** schreibt ihn ins Feld, **„Neu erstellen“** fragt noch einmal, **„Verwerfen“**
   schließt. Nach dem Übernehmen gibt es **„Rückgängig“** (der vorherige Text kommt zurück).
5. Gültig wird der Text erst mit **„Speichern“** des Agenten. Vorher ändert sich am Agenten nichts.

Sehen und benutzen können das Inhaber und Admins — dieselben, die Agenten bearbeiten dürfen.

## Regeln

- **Die KI kennt nur die Stichpunkte**, den Namen des Agenten, den Namen der Organisation, die Art
  des Agenten (Text oder Telefon) und — wenn gewünscht — den vorhandenen Text. Keine Wissensdatenbank,
  keine Konversationen, keine Kundendaten.
- **Nichts erfinden:** Preise, Öffnungszeiten, Produkte, Namen und Zusagen stehen nur im Vorschlag,
  wenn sie in den Stichpunkten stehen. Der Vorschlag enthält keine Regeln zu Wissensquellen,
  Sicherheit der Antwort oder Übergabe-Technik — das regelt Zendori selbst.
- **Telefon-Agenten** bekommen einen Text fürs Sprechen (kurze Sätze, eine Frage auf einmal, keine
  Aufzählungen).
- **Höchstens 20 Vorschläge je Organisation und Stunde.** Danach: „Bitte versuche es in einer Stunde
  noch einmal.“
- **Keine Kosten für den Kunden:** Ein Vorschlag steht nicht im Verbrauchsbuch und auf keiner
  Rechnung. Er kostet Zendori weniger als einen Cent (Sonnet); Modell, Kosten und Dauer stehen an
  der Anfrage.
- **Aufbewahrung:** Stichpunkte und Vorschlag stehen in `agent_prompt_requests` und werden nach
  sieben Tagen vom Worker gelöscht; mit der Organisation verschwinden sie sofort. Nichts davon steht
  in Logs.

## Technik

Die Web-App ruft keine KI auf (CLAUDE.md §4) — wie beim Testlauf einer Data Action:

```
Editor ──request_agent_prompt()──▶ agent_prompt_requests (queued)
                                        │  Worker-Scan, Queue `agent.prompt`
                                        ▼
                                   running ──Sonnet──▶ succeeded (result) | failed (error_code)
Editor ◀──liest die Zeile jede Sekunde──┘
```

- **Migration 0049:** Tabelle `agent_prompt_requests` (org_id, requested_by, agent_kind, agent_name,
  notes, current_identity, state `queued|running|succeeded|failed`, result, error_code, model,
  cost_usd, latency_ms). RLS: lesen nur, wer die Anfrage gestellt hat und noch Inhaber/Admin ist;
  kein Schreiben für Clients. Einziger Eingang: Funktion `request_agent_prompt(org, art, name,
  stichpunkte, vorhandener_text)` — prüft Inhaber/Admin, Längen (Stichpunkte 10–4.000 Zeichen) und
  das Stundenlimit.
- **AI** `packages/ai`: `buildAgentIdentityPrompt`, `buildAgentIdentityUserMessage`,
  `suggestAgentIdentity` (Modell `claude-sonnet-4-6`, das Entwurfs-Modell — der Text steuert danach
  jede Antwort des Agenten und wird einmal geschrieben), `cleanAgentIdentity` (entfernt einen
  Codeblock oder Anführungszeichen um den ganzen Text, höchstens 8.000 Zeichen).
- **Worker** `apps/worker/src/pipeline/agent-prompt.ts`: `processAgentPrompt` übernimmt die Anfrage
  genau einmal (queued → running) und schließt sie selbst ab. **Ein Versuch je Anfrage**, keine
  Wiederholung durch pg-boss. Anfragen älter als 10 Minuten werden nicht mehr beantwortet
  (`expired`); hängt ein Lauf länger als 5 Minuten, schließt ihn der Scan (`stale`). Fehlerwörter:
  `not_configured`, `ai_failed`, `empty_result`, `expired`, `stale`.
- **Web:** `components/IdentityAssistant.tsx`, Aktionen `startIdentitySuggestion` /
  `getIdentitySuggestion` in `settings/agents/actions.ts`.
- **Keine neue Umgebungsvariable**, keine neue Abhängigkeit. `ANTHROPIC_API_KEY` bleibt nur im Worker.

**Reihenfolge:** Migration 0049 zuerst, dann der Code. Ohne die Migration sagt der Knopf „Der
KI-Vorschlag ist noch nicht verfügbar.“ Ohne den neuen Worker bleibt die Anfrage liegen und der
Editor meldet nach gut einer Minute „Das hat zu lange gedauert.“

## Geprüft

typecheck, lint, Tests und Build grün. Neue Tests: `apps/worker/test/agent-prompt.test.ts` (genau
eine Antwort je Anfrage, kein zweiter bezahlter Aufruf, Fehler beenden die Anfrage, abgelaufene
Anfragen kosten nichts, Aufräumen), `packages/ai/test/prompts.test.ts` und
`packages/ai/test/agent-identity.test.ts` (Prompt, Abgrenzung der Stichpunkte, Bereinigung),
RLS-Test in `packages/core/test/rls.test.ts`. Die Migration auf einer lokalen Datenbank: wer
anfragen darf, wer liest, kein direktes Schreiben, Längen, Stundenlimit, Löschen von Nutzer und
Organisation. Zwei echte Aufrufe des Modells mit erfundenen Stichpunkten (Text-Agent neu,
Telefon-Agent überarbeitet von du auf Sie): je 5 bis 7 Sekunden, 0,6 bis 0,8 Cent, 110 bis 130
Wörter, nichts erfunden. **Nicht geprüft:** die Seite im Browser und der Weg über den Worker in
Produktion.

## Testanleitung

Voraussetzung: Migration 0049 eingespielt, Web und Worker auf dem neuen Stand.

1. **Einstellungen → KI-Agenten → einen Text-Agenten öffnen.** Erwartet: unter dem Feld „Identität“
   der Knopf „Mit KI erstellen“.
2. **Klicken, Stichpunkte eintippen** (mindestens 10 Zeichen), „Vorschlag erstellen“. Erwartet:
   „Vorschlag wird geschrieben …“, nach etwa 10 Sekunden ein Text in der zweiten Person („Du bist …“)
   mit einer kurzen Liste von Regeln — ohne erfundene Preise oder Öffnungszeiten.
3. **„Übernehmen“.** Erwartet: Der Text steht im Feld, darunter „Vorschlag übernommen — er gilt erst
   nach dem Speichern.“ mit „Rückgängig“.
4. **„Rückgängig“.** Erwartet: der vorherige Text ist wieder da.
5. **Noch einmal, mit Haken bei „Den vorhandenen Text als Grundlage nehmen“** und dem Stichpunkt
   „Kunden siezen“. Erwartet: der alte Text, umgestellt auf Sie.
6. **Übernehmen, „Speichern“.** Erwartet: „Agent gespeichert.“; nach dem Neuladen steht der neue Text
   im Feld.
7. **Telefon-Agent öffnen, Vorschlag erstellen.** Erwartet: ein Text, der kurze gesprochene Sätze
   verlangt.
8. **„Neuer Agent“ → „Mit KI erstellen“.** Erwartet: funktioniert im Fenster genauso; die Art (Text
   oder Telefon) folgt der Auswahl im Formular.
9. **Als Mitarbeiter ohne Admin-Rolle** einen Agenten öffnen. Erwartet: kein Knopf.
