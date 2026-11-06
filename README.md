# <img src="apps/extension/public/icons/icon-128.png" alt="" width="40" align="center"> Travellite

A Chrome extension that plans a whole trip — flight, hotel and activities — within one total budget.

Tell it where you're flying from, where you want to go, your dates and your budget. It searches
real flights, hotels and activities, then shows up to three complete trips that fit:

- **Best value**: the most trip for the money
- **Best location**: a hotel closer to the center
- **Upgrade**: a better hotel or flight, if the budget allows

Each trip comes with a short summary explaining why it was picked. If nothing fits, Travellite
tells you exactly why, for example "No hotels rated 4.5+ (the highest rated is 4.2)" or the
cheapest flight + hotel for your dates, so you know what to change.

Not quite right? Refine it with one click ("Cheaper hotel", "Fewer stops", "A day earlier") or
in your own words ("hotels under $150 a night"), up to 10 times. When you pick a trip, it's saved
under **My trips** with booking links.

## Run it

You need Node 22.12+, Docker and Chrome.

```bash
npm install
cp .env.example .env              # set INSTALL_TOKEN_KEYS to a random secret (32+ chars)
docker compose up -d redis        # Redis on localhost:6379
npm run dev                       # API on http://localhost:3000
npm run build -w @travellite/extension
```

Then in Chrome: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**
and choose `apps/extension/dist`. Pin the Travellite icon and start planning.

Out of the box it uses recorded sample data, so no provider accounts are needed.

### Settings (`.env`)

| Setting                                          | What it does                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                              | Writes the trip summaries and understands typed refinements. Without it, summaries are simpler and typed refinements are off. |
| `PROVIDER_MODE`                                  | `fixture` (default) uses sample data; `live` makes every provider live.                                                       |
| `FLIGHTS_MODE`, `HOTELS_MODE`, `ACTIVITIES_MODE` | With `PROVIDER_MODE=fixture`, set any of these to `live` to use real data for just that part.                                 |
| `DUFFEL_ACCESS_TOKEN`                            | Needed for live flights or hotels ([Duffel](https://duffel.com/docs); hotel search must be enabled on the account).           |
| `VIATOR_API_KEY`                                 | Needed for live activities ([Viator Partner API](https://docs.viator.com/partner-api/)).                                      |

Restart `npm run dev` after changing `.env`.

## How it works

```
 Chrome extension                         API server                       Outside services
┌──────────────────────┐   HTTPS    ┌──────────────────────────────┐
│ Popup (React)        │──────────▶ │ 1. Constraints from your trip │
│  trip form, results, │            │ 2. Search in parallel ────────┼──▶ Duffel (flights, hotels)
│  refine bar, My trips│            │ 3. Optimizer picks 3 trips    │──▶ Viator (activities)
│                      │ ◀───────── │ 4. Summaries, streamed ───────┼──▶ Claude (summaries)
│ Background worker    │  live      │                              │
│  keeps the trip going│  updates   │ Redis: sessions, events,      │
│  if the popup closes │  (SSE)     │ cached prices, rate limits    │
└──────────────────────┘            └──────────────────────────────┘
```

**The flow**

1. **While you type**, once the route and dates are valid, the extension asks the API to start
   fetching prices, so results are often ready by the time you submit.
2. **When you submit**, the API searches flights, hotels and activities at the same time,
   including nearby dates if you chose flexible dates.
3. **The optimizer**, plain code with no AI, adds up the real totals and keeps only trips within
   your budget and filters. It then picks the best value, best location and upgrade options.
4. **Claude writes a short summary** of each trip. Every number in a summary is checked against
   the actual prices before it's shown.
5. **Results stream** into the popup as each step finishes. You can close the popup; the
   background worker keeps following the trip and picks up where it left off.
6. **Refinements** change only what's affected. "Cheaper hotel" re-ranks hotels without searching
   flights again.
7. **Choosing a trip** saves it in your browser, and the server forgets the session.

**Reliability.** Each provider call has a timeout, one retry and a circuit breaker. Prices are
cached so repeated searches are fast. If activities fail, you still get trips without them. If
flights or hotels fail, you get a message naming the exact cause.

**Privacy.** Saved trips stay in your browser. The server keeps a trip only while you're planning
it.

## Project layout

```
apps/extension    Chrome extension (React, Vite, Manifest V3)
apps/api          API server (Node, Fastify, Redis)
packages/schema   Data types shared by both
fixtures          Recorded sample data for running without provider accounts
Specs             Requirements and detailed design
```

## Development

```bash
npm run ci        # lint, format, typecheck, tests and build (needs Redis)
```

More detail: `Specs/design.md` covers the architecture, and `fixtures/README.md` covers
recording and sample data.
