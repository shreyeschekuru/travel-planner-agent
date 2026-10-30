# Travellite

Browser extension that plans whole trips (flight + hotel + activities) against a total budget.
Specs live in `Specs/`; architecture decisions in `architecture-options/`.

## Layout

```
packages/schema   Zod schemas + types shared by the API and the extension
apps/api          Fastify API (Node 22+)
apps/extension    Chrome MV3 extension (React + Vite)
```

## Development

Requirements: Node 22.12+, Docker (for Redis).

```bash
npm install
cp .env.example .env            # then set INSTALL_TOKEN_KEYS to a real secret
docker compose up -d redis      # Redis on localhost:6379 (required by the API and tests)
npm run dev                     # API on http://localhost:3000
npm run build -w @travellite/extension   # then load apps/extension/dist as an unpacked extension
```

The extension calls `http://localhost:3000` by default. Production builds require an https
`VITE_API_BASE`, e.g. `VITE_API_BASE=https://api.travellite.dev npm run build -w @travellite/extension`.

## Checks

```bash
npm run ci        # lint, format check, typecheck, tests, build (needs Redis)
```

API tests use Redis DB 15 and flush it before each test, so they don't touch development data.
Live LLM tests are off by default because they call the API and cost money:

```bash
LIVE_LLM_TESTS=1 ANTHROPIC_API_KEY=... npm test -w @travellite/api
```
