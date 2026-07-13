# Zendori v2

Eigenständige, mandantenfähige Multichannel-Kundensupport-Plattform: Website-Chat, E-Mail,
WhatsApp und Telefon laufen in einer Shared Inbox zusammen — mit KI-Agent (Klassifikation,
Ticketisierung, RAG-Antworten) und nahtlosem Human-Handoff.

Die verbindliche Spezifikation (Stack, Datenmodell, Phasenplan, Arbeitsregeln) steht in
[CLAUDE.md](CLAUDE.md). Die Analyse der Vorgängersysteme steht in
[docs/legacy-analysis.md](docs/legacy-analysis.md).

## Struktur

```
apps/web          Next.js 15: Inbox, Settings, Widget-Host, Webhooks (Vercel, fra1)
apps/worker       pg-boss Worker: KI-Pipeline, Crawler, Syncs (Docker auf Hetzner, ohne Ingress)
packages/core     Domain-Typen, zod-Schemas, DB-Client, Verschlüsselung, Logger
packages/channels Channel-Adapter-Interface (chat | email | whatsapp | voice)
packages/ai       KI-Pipeline (Modelle/Konstanten; Implementierung ab Phase 4)
supabase/         Migrations (supabase CLI), Seed
docs/             Architektur-Notizen, Legacy-Analyse, Testanleitungen
```

## Entwicklung

Voraussetzungen: Node ≥ 22, pnpm 10, Supabase CLI (für lokale DB / Migrations).

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # muss grün sein
pnpm --filter @zendori/web dev             # Web-App auf http://localhost:3000
pnpm --filter @zendori/worker dev          # Worker (braucht DATABASE_URL_SESSION)
```

Env-Variablen: `.env.example` kopieren und ausfüllen. apps/web-Variablen leben in Vercel
(Production/Preview strikt getrennt), apps/worker-Variablen in `.env` auf dem VPS.

### RLS-Tests

Die RLS-Integrationstests laufen nur, wenn `ZENDORI_TEST_SUPABASE_*` gesetzt ist
(lokale Instanz via `supabase start`, Migrations angewendet). Ohne diese Variablen
werden sie übersprungen, damit `pnpm test` überall grün bleibt.
