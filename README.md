# Travellite

Browser extension that plans whole trips (flight + hotel + activities) against a total budget.
Specs live in `Specs/`; architecture decisions in `architecture-options/`.

## Layout

```
packages/schema   Zod schemas + types shared by the API and the extension
apps/api          Fastify API (Node 22+)
apps/extension    Chrome MV3 extension (React + Vite)
fixtures          Recorded provider responses (see fixtures/README.md)
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

To try the whole flow: run the API (fixture mode needs no provider keys), build the
extension, then in Chrome open `chrome://extensions`, turn on Developer mode, choose
"Load unpacked" and pick `apps/extension/dist`. Without `ANTHROPIC_API_KEY`, package
summaries fall back to code-written bullets and free-text refinements are refused.

The extension calls `http://localhost:3000` by default. Production builds require an https
`VITE_API_BASE`, e.g. `VITE_API_BASE=https://api.travellite.dev npm run build -w @travellite/extension`.

## Search providers

Flights and hotels come from [Duffel](https://duffel.com/docs), activities from the
[Viator Partner API](https://docs.viator.com/partner-api/). By default the API runs in
fixture mode (`PROVIDER_MODE=fixture`) and replays `fixtures/`, so no provider keys are needed.
To call the real APIs, set `PROVIDER_MODE=live`, `DUFFEL_ACCESS_TOKEN` (a `duffel_test_…`
token works) and `VIATOR_API_KEY`.

```bash
npm run fixtures:record -w @travellite/api   # record real responses (needs both keys)
npm run fixtures:synth -w @travellite/api    # regenerate the synthetic fixtures
```

## Checks

```bash
npm run ci        # lint, format check, typecheck, tests, build (needs Redis)
```

API tests use Redis DB 15 and flush it before each test, so they don't touch development data.
The extension's end-to-end test drives the service worker's code against a running API:

```bash
E2E_API_BASE=http://localhost:3000 npm test -w @travellite/extension
```

Live LLM tests are off by default because they call the API and cost money:

```bash
LIVE_LLM_TESTS=1 ANTHROPIC_API_KEY=... npm test -w @travellite/api
```
