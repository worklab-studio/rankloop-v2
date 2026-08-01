# Docker Self-Hosting

Run OpenSEO locally with Docker.

In Docker mode, OpenSEO uses `AUTH_MODE=local_noauth` (no auth checks, local admin user `admin@localhost`). Only expose it behind your own auth-protected reverse proxy, tunnel, or private network.

**There is no published rankloop image yet — you build it.** `ghcr.io/every-app/open-seo:*` is the _upstream_ OpenSEO image and contains none of rankloop; pulling it would silently run a different product. `compose.yaml` therefore defaults to `rankloop:local`, the tag the build step below produces.

## Prerequisites

- Docker Desktop (or Docker Engine + Docker Compose)
- A **git clone of the whole repo**, not just `apps/dashboard` — the image build needs `packages/engine`
- An OpenRouter API key ([openrouter.ai](https://openrouter.ai/settings/keys)) — the writer's key; without it rankloop studies and plans but never writes
- Optional: a DataForSEO API key (see [`DATAFORSEO_API_KEY.md`](./DATAFORSEO_API_KEY.md)) for volume/competitor/backlink data

## Quickstart

From `apps/dashboard`:

```bash
cp .env.example .env
```

Set `OPENROUTER_API_KEY` (and `DATAFORSEO_API_KEY`, if you have one) in `.env`, then build and start:

```bash
docker compose up -d --build
```

Open `http://localhost:<PORT>` (default `3001`). The image build takes several minutes; the container's first start then runs migrations plus a boot-time app build before it serves. Follow both with `docker compose logs -f`.

Optional env values:

- `PORT` (defaults to `3001`)
- `ALLOWED_HOST` (single reverse-proxy hostname to allow in Vite preview)
- `AUTH_MODE=local_noauth` (already set in compose)
- `OPEN_SEO_IMAGE` (defaults to `rankloop:local`)
- `OPENROUTER_MODEL` (model slug override for the writer)
- `INDEXNOW_KEY` (ping IndexNow on publish; needs the matching `<key>.txt` on your site)

If you are putting Docker behind a reverse proxy or a temporary tunnel, remember that Docker self-hosting runs with app auth disabled. Only expose it behind your own auth-protected reverse proxy, tunnel, or private network, and add the public hostname before restarting:

```bash
ALLOWED_HOST=yourdomain.com docker compose up -d
```

You can also persist it in `.env`.

## Telemetry

OpenSEO collects anonymized telemetry for core usage events: heartbeats with aggregate counts (installs, users, projects, feature usage) tied to a random install ID, sent every 5 minutes during the first two hours after install, then at most once daily. Telemetry also includes failed setup check names and statuses, never values or error messages. No URLs, keywords, prompts, emails, or IP-derived location are collected, and idle installs send nothing.

To disable it, set `OPENSEO_TELEMETRY_DISABLED=1` (or `DO_NOT_TRACK=1`) in `.env`, then run `docker compose up -d --force-recreate open-seo`.

## Building the image by hand

`docker compose up --build` covers this, but if you want the raw command: **the
build context is the repo root**, not `apps/dashboard`. The dashboard depends on
`@rankloop/engine` via `link:../../packages/engine`, and a build rooted at
`apps/dashboard` cannot see it. (It would not fail loudly either — `pnpm
install` writes a dangling symlink, the image builds green, and the container
crashloops at start with `Rollup failed to resolve import "@rankloop/engine"`.)

From the repo root:

```bash
docker build -f apps/dashboard/Dockerfile.selfhost -t rankloop:local .
```

Then, from `apps/dashboard`:

```bash
docker compose up -d
```

To run a differently tagged image, set `OPEN_SEO_IMAGE` in `.env`.

## Common commands

- Restart service after env changes:

```bash
docker compose up -d open-seo
```

- Rebuild after pulling new code:

```bash
docker compose up -d --build
```

- Stop (the named volume, and therefore every project, keyword and draft, survives):

```bash
docker compose down
```

## Health and troubleshooting

Startup checks appear in `docker compose logs` before the build. Once running, `/api/health` reports configuration and database status, and `docker compose ps` reports container health.

## Troubleshooting environment variables

To confirm Docker Compose is using the expected environment variables:

```bash
docker compose config
```

Check that `AUTH_MODE=local_noauth`, and that `DATAFORSEO_API_KEY` is the base64
encoded value of your DataForSEO email and API password in this format:
`email:password`.

If you changed `.env`, recreate the container so Compose reapplies it:

```bash
docker compose up -d --force-recreate open-seo
```
