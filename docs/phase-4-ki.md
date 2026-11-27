# Phase 4 — Wissensdatenbank + KI (nur Drafts)

Stand: 2026-07-13. Erste echte Worker-Arbeit: KB-Indexierung und die KI-Pipeline (Klassifikation → Extraktion → RAG → Draft). **Kein Auto-Send, kein Handoff** — das kommt in Phase 5. Antwort-Vorschläge erscheinen in der Inbox, ein Agent übernimmt/bearbeitet/verwirft sie.

## Modelle (CLAUDE.md §3, fix)

- **Klassifikation + Extraktion:** `claude-haiku-4-5` via Structured Outputs (`messages.parse` + zod-Schema).
- **RAG-Draft:** `claude-sonnet-4-6` (plain generation, striktes JSON per Prompt, defensiv geparst — Fallback = niedrige Confidence).
- **Embeddings:** OpenAI `text-embedding-3-small` (1536 dim) via `fetch`, kein SDK.
- Keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) liest `packages/ai` lazy aus der Env; nur der Worker braucht sie.

## Ablauf pro eingehender Nachricht (Worker)

```
scan (alle ~3s): messages mit processing_state='pending' → pg-boss 'ai.process-message' (singletonKey=messageId)
process-message:
  guards (direction=in, sender_type=contact, conversation.mode=bot, state=pending) → sonst nichts tun
  1. classify (Haiku): Sprache, Intent, Priorität, will-Mensch, Spam, Auto-Reply
     → is_spam / is_auto_reply → message 'skipped', kein Draft
  2. classification in message.metadata; conversation.priority setzen
  3. extract (Haiku) NUR bei E-Mail/Formular → echten Absender (Name/E-Mail/Telefon) + Anliegen
     → Contact-Korrektur: find-or-create by email, conversation.contact_id umhängen, Name/Telefon ergänzen
  4. retrieve (RAG, zweistufig seit 0013): embed(query) → rpc hybrid_kb_search (Vektor- +
     Keyword-Suche, RRF-fusioniert, Pool 24) → Haiku-Rerank auf Top 6 (Fallbacks: pre-0013 →
     match_kb_chunks vektor-only; Rerank-Fehler → RRF-Reihenfolge; Voice nutzt Hybrid OHNE
     Rerank wegen Live-Latenz). Org-scoped + gefiltert auf die
     Wissensdatenbanken des zugewiesenen Agenten [0012, agent_knowledge_bases]; Agent ohne
     verknüpfte Datenbank findet nichts — gewollt; force_draft sucht org-weit; Schwelle 0.3, top 6)
  5. draft (Sonnet): Kontext = Top-Chunks + tone_instructions → { reply, confidence, used_source_ids }
  6. ai_drafts: alten pending-Draft verwerfen, neuen pending-Draft speichern (Quellen + Confidence)
  7. message 'done'; jeder Schritt in ai_runs (Modell, Confidence, latency, cost_usd)
```

Fehler in einem Schritt → geworfen → pg-boss retryt (retryLimit); nach Erschöpfung markiert `handlePipelineFailure` die Nachricht `skipped` (kein Endlos-Reenqueue). Keine Nachrichteninhalte in Logs (§7).

## KB-Indexierung (Worker)

```
scan: kb_sources mit status='pending' → pg-boss 'kb.index-source' (singletonKey=sourceId)
index-source:
  text → Datei <org>/<source_id>/text.txt aus Bucket kb-files lesen
  file → PDF (pdf-parse) / DOCX (mammoth) / txt/md aus kb-files
  url  → Seite(n) fetchen (Sitemap bis 20 Seiten, http(s), 10s/Seite, 500k-Zeichen-Cap) → htmlToText
  → chunkText (~500 Token, 50 Overlap) → embed (Batch) → alte kb_chunks ersetzen → status='indexed'
```

## Inbox: Antwort-Vorschlag

`getConversationDetail` lädt den neuesten `ai_drafts`-Eintrag mit `status='pending'`. Die `SuggestedReply`-Karte über dem Composer zeigt Text, Confidence (farbcodiert gegen 0.7) und Quellen. Aktionen: **Übernehmen** (sendet den Text wie eine Agent-Antwort inkl. E-Mail-Versand, Draft → `accepted`), **Bearbeiten** (Inline-Textarea, sendet bearbeitet, Draft → `edited`), **Verwerfen** (Draft → `discarded`). Realtime: die Publication enthält `ai_drafts`, der Inbox-Refresher zieht neue Drafts live.

## Datenmodell (Migration 0005)

- `hybrid_kb_search(p_org_id, p_query, p_embedding, p_match_count, p_knowledge_base_ids)` (0013) → RRF-fusionierte Kandidaten aus Vektor- (Cosinus, Gate 0.15) und Keyword-Zweig (`kb_chunks.fts`, german, GIN); `similarity` = RRF-Score. `ai_runs.step` kennt zusätzlich `rerank`.
- `match_kb_chunks(p_org_id, p_embedding, p_match_threshold, p_match_count, p_knowledge_base_ids uuid[] default null)` → Top-Chunks per Cosinus (hnsw-Index + iterative_scan), org-gefiltert; `null` = alle Datenbanken der Org, `[]` = keine Treffer (Migration 0012 — die alte 4-Parameter-Signatur wurde ersetzt).
- `ai_drafts` (org_id, conversation_id, message_id, content, confidence, sources jsonb, model, status pending|accepted|edited|discarded). RLS: Member lesen/Status ändern, Worker (Service Role) schreibt. Unique-Index: max. 1 pending pro Konversation. In Realtime-Publication.
- Bucket `kb-files` (privat, Org-Member-Read, Service-Role-Write).

## Kosten

Pro Anthropic-/Embedding-Call aus `usage` berechnet und in `ai_runs.cost_usd` geloggt. Eine typische Runde (classify + retrieve + draft) kostet ~$0,005.

## Manueller Test

1. Worker starten (`pnpm --filter @zendori/worker start`, braucht die Env inkl. AI-Keys).
2. Einstellungen → Wissensdatenbank → Datenbank-Kachel wählen (oder anlegen) → Text/URL/Datei hinzufügen → Status wird `indexed`. Die Datenbank muss beim Agenten des Kanals angehakt sein (Einstellungen → Agenten), sonst nutzt die KI sie nicht.
3. Über den Test-Channel/das Widget eine Frage einspeisen, die die KB beantwortet.
4. Inbox → Konversation öffnen: der Antwort-Vorschlag erscheint mit Confidence + Quelle.
5. Übernehmen/Bearbeiten/Verwerfen testen.
6. Spam-Nachricht einspeisen → kein Vorschlag (klassifiziert + übersprungen).

## Anführungszeichen: Entwurfs-Hülle und abgeschnittene Felder (2026-11-27)

**Vorfall (2026-11-26):** Ein übernommener Vorschlag ging als rohe Modell-Antwort an einen Kunden —
`{"reply": "…", "confidence": 0.95, "used_source_ids": […]}` statt nur des Antworttexts.

**Ursache:** Die Modelle schreiben eine deutsche Anführung — „Hörprobe“ — mit einem **geraden**
Schlusszeichen und maskieren es nicht. Im JSON beendet dieses Zeichen den Text. Zwei Folgen:

1. **Entwurf (Sonnet, Hülle nur im Prompt verlangt):** Die Hülle ist kein gültiges JSON mehr. Bisher
   wurde dann die ganze Roh-Antwort zum Vorschlag (Sicherheit 0,3). In Produktion 4 von 80 Entwürfen
   (5 %); nennt die Antwort einen Knopf in Anführungszeichen, im Versuch 10 von 10.
2. **Klassifikation, Extraktion, Lernen (Haiku, Ausgabeform von der API erzwungen):** Das JSON bleibt
   gültig, aber das Feld **endet still am Anführungszeichen**. Eine Ticket-Beschreibung von 208
   Zeichen kam im Versuch mit 55 zurück. In Produktion bisher nicht aufgetreten (keine eingegangene
   Nachricht enthielt „…“), mit E-Mails aus Outlook oder Word aber zu erwarten.

**Was jetzt gilt:**

- **Die Hülle wird an ihrem Rahmen zerlegt**, wenn sie kein gültiges JSON ist
  (`packages/core/src/draft-envelope.ts`, `recoverDraftEnvelope`): Die Antwort ist, was zwischen
  `{"reply": "` und den abschließenden Feldern steht; diese müssen für sich gültiges JSON sein und
  dürfen nur Sicherheit und Quellen enthalten. Text und Sicherheit bleiben vollständig erhalten.
- **Eine rohe Hülle wird nie Vorschlag oder Nachricht** (`finalizeDraftResult`): Was sich nicht
  zerlegen lässt, wird durch die sichere Ersatzantwort mit Sicherheit 0 ersetzt.
- **Die Inbox zeigt und sendet nur die Antwort** (`draftTextForCustomer` in `lib/inbox/queries.ts`
  und `acceptDraft`): Ein gespeicherter Entwurf, der noch die Hülle ist, wird als seine Antwort
  angezeigt und gesendet — oder gar nicht, wenn er sich nicht lesen lässt.
- **Kundentext geht mit geraden Anführungszeichen an die Modelle** (`plainQuotes` in
  `packages/ai/src/prompts.ts`): „ “ ” werden zu `"`. Gerade Anführungszeichen maskieren die
  Modelle richtig. Zusätzlich gilt ein Feld, das in einer offenen Anführung endet, als abgeschnitten
  (`cutAtOpenQuote`): Die Beschreibung wird dann durch die ganze Nachricht ersetzt, ein Betreff
  verliert nur das Zeichen, ein halber Lern-Eintrag wird verworfen.

**Bewusst NICHT gemacht:** die Ausgabeform des Entwurfs von der API erzwingen (structured outputs).
Gemessen: Das JSON wäre dann immer gültig, die Antwort aber am ersten Anführungszeichen
abgeschnitten (104 statt 324 Zeichen) — still und schlimmer als der sichtbare Fehler. Ein Hinweis im
Prompt („keine geraden Anführungszeichen“) änderte nichts (0 von 10).

**Geprüft:** Tests in `packages/core/test/draft-envelope.test.ts`, `packages/ai/test/draft-parse.test.ts`,
`draft-tools.test.ts`, `quote-guard.test.ts`. Gegen die echte API mit erfundenem Inhalt: Entwurf 11
von 11 vollständig und ohne Hülle (auch mit Werkzeug-Aufruf), Extraktion 12 von 12 vollständig
(vorher 0 von 8 bei „…“), Lernen 4 von 4.
