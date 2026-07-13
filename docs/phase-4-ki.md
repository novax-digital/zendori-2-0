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
  4. retrieve (RAG): embed(query) → rpc match_kb_chunks (org-scoped, Schwelle 0.3, top 6)
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

- `match_kb_chunks(p_org_id, p_embedding, p_match_threshold, p_match_count)` → Top-Chunks per Cosinus (hnsw-Index), org-gefiltert.
- `ai_drafts` (org_id, conversation_id, message_id, content, confidence, sources jsonb, model, status pending|accepted|edited|discarded). RLS: Member lesen/Status ändern, Worker (Service Role) schreibt. Unique-Index: max. 1 pending pro Konversation. In Realtime-Publication.
- Bucket `kb-files` (privat, Org-Member-Read, Service-Role-Write).

## Kosten

Pro Anthropic-/Embedding-Call aus `usage` berechnet und in `ai_runs.cost_usd` geloggt. Eine typische Runde (classify + retrieve + draft) kostet ~$0,005.

## Manueller Test

1. Worker starten (`pnpm --filter @zendori/worker start`, braucht die Env inkl. AI-Keys).
2. Einstellungen → Wissensdatenbank → Text/URL/Datei hinzufügen → Status wird `indexed`.
3. Über den Test-Channel/das Widget eine Frage einspeisen, die die KB beantwortet.
4. Inbox → Konversation öffnen: der Antwort-Vorschlag erscheint mit Confidence + Quelle.
5. Übernehmen/Bearbeiten/Verwerfen testen.
6. Spam-Nachricht einspeisen → kein Vorschlag (klassifiziert + übersprungen).
