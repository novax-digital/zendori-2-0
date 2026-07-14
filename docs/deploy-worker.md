# Deploy: apps/worker → Hetzner (Docker)

The worker is a **single container with no ingress** — no Traefik, no domain, no
open ports, only outbound connections (Supabase incl. Realtime, Anthropic/OpenAI,
Resend, Twilio, HubSpot, and — Phase 9 — an outbound WebSocket to xAI). CLAUDE.md §12.

## How it works (the whole pipeline)

```
push to main ──> GitHub Action "Worker Image" builds apps/worker/Dockerfile
             ──> pushes ghcr.io/novax-digital/zendori-worker:<git-sha>  (and :main)
                                   │
        on the VPS:  docker compose pull && docker compose up -d
                                   │
             ──> container runs `tsx src/index.ts` (pg-boss worker)
                 · scans for pending inbound messages (KI pipeline)
                 · Realtime-subscribes for voice-call dispatch
                 · writes a heartbeat file every minute → Docker HEALTHCHECK
```

The image is **already built on every push to main** — nothing to build by hand.
Deploying = pointing the VPS at a specific image tag and running two commands.

## One-time VPS setup

Docker + compose v2 are already installed on the box. Always use `sudo docker
compose` (v2, with a space), never `docker-compose`.

### 1. Authenticate to GHCR (needed if the package is private)

The image lives under the private org package `novax-digital/zendori-worker`.
Create a GitHub **Personal Access Token (classic)** with only the `read:packages`
scope (from an account that can read the org's packages), then on the VPS:

```bash
echo "<THE_PAT>" | sudo docker login ghcr.io -u <github-username> --password-stdin
```

(Alternatively, make the GHCR package **internal/public** in its package settings
and skip this — but a read-only PAT is the tighter default.)

### 2. Put the deploy files in one directory

The container needs only two files — no repo checkout required.

```bash
sudo mkdir -p /opt/zendori-worker && cd /opt/zendori-worker
```

Create `docker-compose.yml` with exactly the contents of
[apps/worker/docker-compose.yml](../apps/worker/docker-compose.yml):

```yaml
services:
  worker:
    image: ghcr.io/${GHCR_OWNER}/zendori-worker:${WORKER_IMAGE_TAG}
    restart: unless-stopped
    env_file: .env
```

Create `.env` from [apps/worker/.env.example](../apps/worker/.env.example) and
fill in the real values, then lock it down:

```bash
sudo chmod 600 /opt/zendori-worker/.env
```

Required keys (worker fails fast without the first four):
`DATABASE_URL_SESSION` (session-mode connection, **port 5432 / session pooler — never
the transaction pooler**), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`MASTER_ENCRYPTION_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RESEND_API_KEY`,
`RESEND_FROM`, `INBOUND_EMAIL_DOMAIN`. Voice (`XAI_API_KEY`) is optional — absent
disables the voice dispatch cleanly.

### 3. Pick the image tag

Pin an **immutable per-commit tag** (the git SHA), not `:latest`/`:main`
(CLAUDE.md §12 — a Docker auto-update once caused an outage on this box). Find the
SHA of the build you want:

```bash
# from a machine with gh:  gh run list --workflow=worker-image.yml --limit 5
# then set in .env, e.g.:
WORKER_IMAGE_TAG=d958f96...     # full 40-char SHA
GHCR_OWNER=novax-digital
```

## Deploy / update

> **Migrations first.** Apply pending Supabase migrations (`npx supabase db push
> --db-url "$DATABASE_URL_SESSION"`, owner-approved) BEFORE bumping
> `WORKER_IMAGE_TAG` — worker images auto-build on every push to main, so the
> code can be ahead of the schema. The worker tolerates the known skews
> (42P01/42703: work stays pending, voice falls back to intake mode), but
> running schema-ahead is the supported direction, not the reverse.

```bash
cd /opt/zendori-worker
sudo docker compose pull        # fetch the pinned image
sudo docker compose up -d       # (re)start detached
```

To ship a newer build: bump `WORKER_IMAGE_TAG` to the new SHA, then `pull` + `up -d`.

## Verify

```bash
sudo docker compose ps          # STATUS should become "healthy" within ~90s
sudo docker compose logs -f     # watch startup; LOG_LEVEL=warn keeps it quiet
```

Healthy = the pg-boss heartbeat job is touching `/tmp/zendori-worker-heartbeat`
every minute (the Docker HEALTHCHECK reads its mtime; stale > 3 min → unhealthy →
auto-restart). A quiet log with a healthy status means it connected to Supabase
and is polling.

> On the **first start of a new version** the worker recreates its pg-boss queues
> with the correct policy. This discards any transient in-flight jobs; the scan
> loop re-enqueues pending work automatically. Expected, no action needed.

## Troubleshooting

- **`pull` → 403 / denied**: GHCR auth. Re-run the `docker login` step with a PAT
  that has `read:packages` and access to the org package (or make the package
  internal/public).
- **Container restarts / exits on boot**: usually a missing required env var — the
  worker calls `loadWorkerEnv()` and throws on the first missing one. Check
  `sudo docker compose logs`.
- **pg-boss connection errors**: `DATABASE_URL_SESSION` must be the **session/direct**
  connection (port 5432 or the session pooler). The transaction pooler breaks
  pg-boss. The worker creates a `pgboss` schema in the DB on first run (intended).
- **Never unhealthy but no work processed**: check the org has active channels and
  that inbound messages exist with `processing_state='pending'`.

## Rollback

Set `WORKER_IMAGE_TAG` back to the previous known-good SHA, then
`sudo docker compose pull && sudo docker compose up -d`.
