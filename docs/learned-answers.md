# Gelernte Antworten — der Lern-Loop (Migration 0020)

Der Agent wird mit jeder Konversation besser, **ohne Modell-Training**: Antworten
von Menschen werden zu generalisierten, PII-freien Q&A-Paaren destilliert, von
einem Menschen freigegeben und landen als ganz normale Wissensbausteine in einer
automatischen Wissensdatenbank „Gelernte Antworten".

## Ablauf

```
Mensch antwortet in der Inbox
  a) Freitext-Antwort während mode='human'      → origin 'handoff_resolution'
  b) KI-Entwurf deutlich geändert + gesendet    → origin 'draft_correction'
→ apps/web schreibt learned_answers-Zeile (status 'candidate', message_id unique)
→ Worker-Scan (1 s) → Queue learned.distill → Haiku destilliert:
    generalisieren + STRENG PII-frei + worth_learning-Entscheid
    → 'proposed' (Frage/Antwort gesetzt)  oder  'auto_rejected'
→ Review-UI: Einstellungen → Wissensdatenbank → „Gelernte Antworten"
    Mensch prüft/bearbeitet → Übernehmen ('approved') oder Ablehnen ('rejected')
→ Übernehmen stellt nur sicher, dass die System-Quelle existiert
    (kb_sources.is_learned, unique pro Org) und setzt sie auf 'pending'
→ der WORKER kompiliert die Chunks beim Indexieren DIREKT aus allen
    approved-Zeilen (kein Storage-File, race-frei bei parallelen Freigaben):
    ein Chunk pro Paar mit Kopfzeile „Quelle: Gelernte Antworten"
→ RAG findet die Paare ab der nächsten ähnlichen Frage
```

Wichtig: Die Wissensdatenbank „Gelernte Antworten" muss unter Einstellungen →
Agenten mit den Agenten **verknüpft** werden (owner-only, einmalig) — sonst wird
sie von keiner KI durchsucht.

## DSGVO-Design

- **PII-Strip + Generalisierung** passiert bei der Destillation (Prompt-Regeln:
  keine Namen/E-Mails/Telefonnummern/Bestellnummern/Adressen; Einzelfall → Regel).
- **Menschliche Freigabe** vor jeder Übernahme; Bearbeiten im Review möglich.
- Gespeichert wird org-scoped (RLS), einzeln löschbar, `org.purge`-erfasst.
- Keine neuen Prozessoren: dieselben Anthropic/OpenAI-Calls wie die Pipeline.
- `ai_runs.step='learn'` loggt nur Kosten/Latenz + content-freie Summaries.

## Schema-Skew (Worker/Web vor Migration 0020)

- Web-Kandidaten-Insert ist best-effort (try/catch) — Antworten senden bricht nie.
- Worker-Scan toleriert fehlende Tabellen still (42P01 UND PGRST205 — PostgREST
  meldet fehlende Tabellen aus dem Schema-Cache als PGRST205).
- Worker-Indexer lädt `kb_sources.is_learned` mit 42703-Fallback (Spalte fehlt
  vor 0020; eine Learned-Quelle kann dann ohnehin nicht existieren).
- 0020 erweitert außerdem `ai_runs_step_check` um `'transcribe'` (latenter Bug:
  Voice-Note-Logging verletzte den Constraint seit 2d2c207 und kostete pro
  Sprachnachricht einen pg-boss-Retry) und `'learn'`, und ergänzt
  `messages`/`conversations` um unique(id, org_id) für die Same-Org-Composite-FKs
  (verhindert Cross-Org-Referenzen in learned_answers — Exfiltrations-Schutz).

## Grenzen / bewusste Entscheidungen

- Max. 2.000 Paare in der System-Quelle; beim Überschreiten behält der Worker
  die NEUESTEN 2.000 (alte Learnings altern aus).
- Origin-Nachricht gelöscht ⇒ message_id wird genullt (SET NULL): freigegebene
  Paare überleben Konversations-Löschungen; unverarbeitete Kandidaten werden
  auto-verworfen.
- `draft_correction` feuert bei jeder materiellen Änderung (whitespace-insensitiv);
  Kleinst-Korrekturen erzeugen Vorschläge, die der Reviewer einfach ablehnt.
- Paralleles Freigeben ist unkritisch: Freigaben stoßen nur die Neuindizierung
  an; kompiliert wird immer der aktuelle DB-Stand.
- Voice ist v1 außen vor (Rückrufe laufen nicht über die Inbox-Reply-Actions).

## Manuelle Testanleitung

1. Migration 0020 anwenden (Freigabe!), Worker mit neuem Stand starten.
2. Konversation im Test-Channel/Chat anlegen, Frage stellen, in der Inbox
   „Übernehmen" klicken (mode='human') und als Mensch eine sachliche Antwort
   senden (z. B. „Die Wallbox X7 lädt mit maximal 11 kW.").
3. Nach wenigen Sekunden: Einstellungen → Wissensdatenbank → Banner „1 Vorschlag
   wartet auf Prüfung" → „Vorschläge prüfen".
4. Erwartung: generalisierte Frage + Antwort ohne Namen/Adressen. Ggf. anpassen,
   „In Wissensdatenbank übernehmen".
5. Erwartung: KB „Gelernte Antworten" existiert mit Quelle
   `gelernte-antworten.csv` (Status „Ausstehend" → „Indiziert"), Textbausteine
   zeigen `Frage:/Antwort:`-Paar mit „Quelle: gelernte-antworten"-Kopfzeile.
6. KB unter Einstellungen → Agenten mit dem Test-Agenten verknüpfen, dieselbe
   Frage neu stellen (neue Konversation) → der Draft zitiert die gelernte Antwort.
7. Entwurf-Korrektur-Pfad: In einer Bot-Konversation einen Vorschlag über
   „Bearbeiten" inhaltlich ändern und senden → neuer Vorschlag mit Quelle
   „Korrigierter KI-Entwurf".
8. Negativ: „Danke, tschüss!"-Antwort erzeugt keinen Vorschlag (auto_rejected).
