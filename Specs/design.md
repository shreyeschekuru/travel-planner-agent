# Travellite Design

**Project:** Travel Planning Assistant (Browser Extension)  
**Format:** AI-Agent Optimized  
**Version:** 2.0 (replaces the LangGraph design, archived in `_archive-v1-langgraph/`)  
**Last Updated:** 2026-10-29  
**Requirements:** `requirements.md` · **Tasks:** `tasks.md`

Sections are tagged 🟢 **MVP** or 🔵 **FULL**. Part 1 is the complete MVP design. Part 2 lists only what FULL adds or changes.

---

## Design Principles

1. **Code decides, the LLM translates.** Prices, totals, dates, ranking and feasibility are computed in code. The LLM turns user text into constraints and results into readable text.
2. **A fixed pipeline, not an agent loop.** The main flow is a plain TypeScript orchestrator. The only agent is the bounded Q&A side channel (🔵 FULL).
3. **Every LLM output is schema-constrained and grounded.** Structured outputs, enum-limited fields, claims cite input fields, a validator drops anything that doesn't match.
4. **Stateless servers.** All session state and events live in Redis; any instance serves any request.
5. **Degrade, never fake.** A failed provider or LLM call removes a feature from the response; it never inserts invented data.

---

# PART 1 — 🟢 MVP

## 1. System Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Browser Extension (MV3, React + TS)                        │
│  popup: TripForm · PackagesView · RefineBar · MyTrips      │
│  service worker: SSE client, API client, storage sync      │
│  storage: chrome.storage (draft, token) · IndexedDB (trips)│
└──────┬───────────────────────┬──────────────────┬──────────┘
       │ POST /v1/prefetch     │ POST /v1/sessions│ /refine · /select
       │                       │ GET  …/events (SSE)
┌──────▼───────────────────────▼──────────────────▼──────────┐
│ API (Fastify, Node 20, stateless)                          │
│  auth (install token) · rate limit · JSON schema validation│
│                                                            │
│  Orchestrator                                              │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────┐   │
│  │Constraint│─▶│ Search   │─▶│ Optimizer │─▶│ Explain  │   │
│  │ builder  │  │ parallel │  │  (code)   │  │ 1× LLM   │   │
│  └──────────┘  └────┬─────┘  └───────────┘  └──────────┘   │
│        ▲            │                                      │
│        └─ Refine: delta → rerun affected branch            │
│                     │                                      │
│  Provider adapters: timeout · retry · breaker · validation │
└──────┬──────────────┼──────────────────────────────────────┘
       ▼              ▼
  Redis               Duffel (flights + stays) · Viator · ECB FX
  sessions · events   Claude Haiku 5.5
  caches · limits
  spend counter
```

## 2. Repository Layout

```
travellite/
├─ packages/
│  └─ schema/          # Zod schemas + TS types shared by api and extension
├─ apps/
│  ├─ api/
│  │  ├─ src/routes/        prefetch.ts · sessions.ts (create, events, refine, select)
│  │  ├─ src/orchestrator/  run-session.ts (first run and refinement reruns)
│  │  ├─ src/core/          constraints.ts · optimizer.ts · deltas.ts · budget-advice.ts
│  │  ├─ src/llm/           client.ts · pricing.ts · untrusted.ts · json-items.ts
│  │  │                     explain.ts · explain-input.ts · fallback.ts · grounding.ts
│  │  │                     parse-delta.ts
│  │  ├─ src/providers/     provider.ts · http.ts · resilience.ts · breaker.ts · token-bucket.ts
│  │  │                     duffel-flights.ts · duffel-stays.ts · viator.ts · fx.ts
│  │  │                     normalize.ts · fixtures.ts · index.ts
│  │  ├─ src/search/        search.ts · date-pairs.ts
│  │  ├─ scripts/           record-fixtures.ts · synth-fixtures.ts · synthetic.ts
│  │  ├─ src/store/         redis.ts · keys.ts · sessions.ts · events.ts · cache.ts
│  │  ├─ src/limits/        rate-limit.ts · spend.ts · semaphore.ts
│  │  └─ src/auth/          install-token.ts · origin.ts
│  └─ extension/
│     ├─ src/popup/         App.tsx · TripForm.tsx · PackagesView.tsx · RefineBar.tsx · MyTrips.tsx
│     └─ src/worker/        service-worker.ts · controller.ts · trip-state.ts · sse.ts · api.ts
│                           install.ts · trips-db.ts · messages.ts
├─ fixtures/           # recorded provider responses
└─ evals/              # scenarios, graders, CI runner
```

## 3. Request Flow

```
[typing] origin+destination+dates valid ──debounce 800ms──▶ POST /v1/prefetch
                                                           warm flight + hotel caches
[submit] POST /v1/sessions ─▶ {session_id, stream_url}
         GET  …/events (SSE)
  1. buildConstraints(config)                    <1 ms
  2. search(constraints)  ‖ flights (date grid) ‖ hotels (per date pair) ‖ activities
       emit results / degraded per category
  3. optimize(results, constraints)              <50 ms
       none fit → emit budget_advice, stop
       else    → emit packages
  4. explain(packages)                           1 LLM call, streamed
       emit explanation per package
  5. emit awaiting_selection
[refine] POST …/refine {chip|text} → delta → rerun affected branch → 3 → 4
[select] POST …/select {package_id} → itinerary → extension saves → server deletes session
```

## 4. Data Schemas

All schemas live in `packages/schema` as Zod definitions; TS types are inferred.

```ts
// ---------- Input ----------
interface VacationConfig {
  origin: IATA;
  destination: CityId;
  departure_date: ISODate;
  return_date: ISODate;
  date_flex_days: 0 | 1 | 2;
  budget_usd: number;              // total trip, all travelers
  travelers: number;
  preferences: Preference[];
}

// ---------- Constraints ----------
interface Constraints {
  dates: { depart: ISODate; return: ISODate; flex_days: number };
  budget: { total_usd: number; tolerance_pct: number };          // default 5
  flight: { max_stops: number; max_price_usd?: number;
            earliest_depart?: HHMM; latest_arrive?: HHMM };
  hotel:  { min_rating: number; max_price_per_night_usd?: number;
            max_km_from_center?: number };
  activities: { interests: Preference[]; max_per_day: number;
                max_price_each_usd?: number };
  travelers: number;
}

// ---------- Normalized options ----------
interface Option {
  id: string;                      // "duffel:off_…", "duffel:srr_…", "viator:…"
  category: "flight" | "hotel" | "activity";
  title: string;
  price: { amount: number; currency: "USD" };
  price_basis: "total" | "per_night" | "per_person";
  rating?: number;
  location?: { lat: number; lng: number };
  url: HttpsUrl;
  attrs: FlightAttrs | HotelAttrs | ActivityAttrs;
}
interface FlightAttrs   { depart_at: LocalDateTime; arrive_at: LocalDateTime;   // airport-local,
                          return_depart_at: LocalDateTime;                 // no offset
                          return_arrive_at: LocalDateTime; stops: number;
                          duration_min: number; carrier: string }
interface HotelAttrs    { checkin: ISODate; checkout: ISODate; nights: number;
                          km_from_center?: number }
interface ActivityAttrs { tags: Preference[]; duration_min?: number }

// ---------- Optimizer output ----------
interface TripPackage {
  id: string;
  label: "best_value" | "best_location" | "upgrade";
  flight: Option;
  hotel: Option;
  activities: Option[];
  total_usd: number;
  score: number;
  score_breakdown: { cost_fit: number; flight_convenience: number;
                     hotel_location: number; rating: number; pref_match: number };
}
interface BudgetAdvice {
  cheapest_total_usd: number;
  driver: "flight" | "hotel" | "activities";
  nearest_fitting_dates?: { depart: ISODate; return: ISODate; total_usd: number };
}

// ---------- LLM output ----------
interface PackageExplanation {
  package_id: string;              // enum of input package IDs
  headline: string;                // ≤ 80 chars
  pros: Claim[];                   // 2–3
  cons: Claim[];                   // 1–3
}
interface Claim { text: string; source_fields: string[] }

// ---------- Refinement ----------
type RefineChip = "cheaper_hotel" | "better_hotel" | "fewer_stops"
                | "shift_dates_earlier" | "shift_dates_later" | "more_activities";
interface ConstraintDelta {
  ops: { path: DeltaPath; op: "set" | "scale" | "add" | "remove"; value: unknown }[];
  reason: string;                  // shown to the user
}
type DeltaPath =
  | "budget.total_usd" | "dates.depart" | "dates.return"
  | "flight.max_stops" | "flight.max_price_usd" | "flight.earliest_depart" | "flight.latest_arrive"
  | "hotel.min_rating" | "hotel.max_price_per_night_usd" | "hotel.max_km_from_center"
  | "activities.interests" | "activities.max_per_day" | "activities.max_price_each_usd";

// ---------- Session (Redis, TTL 24 h) ----------
interface SessionRecord {
  id: string;
  install_id: string;
  status: "searching" | "awaiting_selection" | "refining" | "selected" | "failed";
  config: VacationConfig;
  constraints: Constraints;
  delta_history: ConstraintDelta[];          // ≤ 10
  results: Record<"flight" | "hotel" | "activity",
                  { option_ids: string[]; fetched_at: ISODateTime; degraded: boolean }>;
  packages: TripPackage[];
  explanations: PackageExplanation[];
  created_at: ISODateTime;
}
```

Options themselves are stored in the search cache, keyed by option ID; the session stores IDs only.

## 5. Components

### 5.1 Constraint builder 🟢
Pure function `buildConstraints(config) → Constraints`. Defaults: `max_stops = 1`, `min_rating = 3.5`, `max_per_day = 2` (1 if `relaxed_pace`), `tolerance_pct = 5`.

### 5.2 Provider adapters 🟢
| Category | Provider | Notes |
|---|---|---|
| Flights | Duffel `/air/offer_requests` | Replaces Amadeus Self-Service, shut down 2026-07-17 |
| Hotels | Duffel Stays `/stays/search` | Same token, rate limit and breaker as flights |
| Activities | Viator Partner API `/products/search` | Basic (affiliate) access |
| FX | ECB daily reference rates | Cached 12 h; items with an unknown currency are dropped |

```ts
interface SearchProvider<P> {
  name: "duffel" | "viator";
  category: "flight" | "hotel" | "activity";
  search(params: P, signal?: AbortSignal): Promise<Result<Option[], ProviderError>>;
}
type ProviderError = { kind: "TIMEOUT" | "RATE_LIMIT" | "NOT_FOUND" | "BAD_PAYLOAD" | "AUTH"
                             | "UNAVAILABLE" | "BREAKER_OPEN";
                       retry_after_ms?: number };
```
- All HTTP goes through a `Transport` (live `fetch`, fixture replay, or recording), wrapped per provider by `ResilientHttp`:
  - per-attempt timeout: flights 7 s (Duffel `supplier_timeout` 5 s, since airlines answer slowly), hotels 4 s, activities 2.5 s;
  - ≤ 1 retry on 429/5xx/network errors with jitter and `retry-after` (retries are skipped when the wait would exceed 1 s); no retry after a timeout;
  - circuit breaker per instance (open after 5 failures in 60 s, one half-open trial after 30 s);
  - shared Redis token bucket per provider, holding 2 s of tokens for bursts.
- Status mapping: 401/403 → `AUTH`, 400/404/422 → `NOT_FOUND`, 429 → `RATE_LIMIT`, 5xx/network → `UNAVAILABLE`.
- Raw responses validated with Zod; invalid items dropped and counted (`onDropped`).
- Normalization sets `price_basis` (flights and hotels `total`, activities `per_person`) and converts prices to USD.
- Booking URLs must be https on an allowlisted host (`www.google.com`, `www.viator.com`). Duffel has no consumer booking page, so flights and hotels link to a Google Flights / Google Hotels search. **Open decision before launch:** keep these, or book through Duffel (which would make Travellite a seller, against the "never books" requirement).
- Destinations come from a fixed catalog (`packages/schema/src/cities.ts`) holding IATA code and city center. Viator destination IDs and tag names are looked up at runtime and cached 7 days.
- **Flights with flex dates:** the whole trip shifts by −flex…+flex days (≤ 5 pairs, trip length unchanged). Duffel has no cheapest-date endpoint, so every pair is a full offer request, run in parallel and cached separately. The 3 pairs with the cheapest offers are kept, plus the top 10 flights across them. Hotels are searched for every candidate pair alongside flights and filtered to the kept pairs.
- **Fixture mode** (`PROVIDER_MODE=fixture`, the default): replays `fixtures/` with dates shifted to the request. See `fixtures/README.md`.
  - In fixture mode, `FLIGHTS_MODE`, `HOTELS_MODE` and `ACTIVITIES_MODE` can each be set to `live` to call that provider for real. `PROVIDER_MODE=live` overrides them and makes every provider live. Fixture results are cached under a `fixture:` prefix, so switching a provider to live never serves them.

### 5.3 Search cache 🟢
| Key | TTL |
|---|---|
| `flights:{origin}:{dest}:{depart}:{return}:{travelers}` | 15 min |
| `hotels:{dest}:{checkin}:{checkout}:{travelers}` | 1 h |
| `activities:{dest}` | 24 h |
| `option:{id}` | max of the above |

### 5.4 Joint optimizer 🟢
**Input:** ≤ 10 flights (across date pairs), ≤ 10 hotels per date pair, ≤ 20 activities.

**Totals** (code only):
```
flight_total   = price_basis == "per_person" ? price × travelers : price
hotel_total    = price_basis == "per_night"  ? price × nights   : price
activity_total = Σ (price_basis == "per_person" ? price × travelers : price)
total_usd      = flight_total + hotel_total + activity_total
```

**Hard constraints:** budget with tolerance, matching dates, `stops ≤ max_stops`, `rating ≥ min_rating`, optional max prices.

**Score:** `w1·cost_fit + w2·flight_convenience + w3·hotel_location + w4·rating + w5·pref_match`, each normalized 0–1. Weights live in config and are tuned against fixtures.
- `cost_fit`: peaks at ~85–100% of budget; penalizes waste and overspend.
- `flight_convenience`: fewer stops, shorter duration, arrival between 08:00 and 22:00.
- `hotel_location`: distance to the activity centroid (fallback: city center).
- `pref_match`: share of activity tags matching preferences.

**Activities:** greedy by `pref_match / price` under the remaining budget, up to `max_per_day × nights`.

**Packages:** brute-force all flight × hotel pairs (~100), fill activities, then:
- `best_value` = max `score / total_usd`
- `best_location` = max `hotel_location` among the top-quartile `score`
- `upgrade` = max `score`
- Drop duplicates (same flight and hotel); return 2–3.

**No fit:** return `BudgetAdvice` (cheapest total, the category that drives it, nearest fitting date pair from the cached grid).

### 5.5 LLM client 🟢
- Anthropic TypeScript SDK; model `claude-haiku-5-5`; `output_config.effort: "low"`.
- Structured outputs with the Zod schema from `packages/schema` (SDK structured-output helper).
- SDK `maxRetries: 1`; no application-level LLM retries.
- Stable system prompt + schema kept ≥ 512 tokens with `cache_control` so it is prompt-cached; verify via `usage.cache_read_input_tokens`.
- Untrusted text (provider titles, user text) wrapped in `<data>` delimiters; the system prompt states it is data, not instructions.
- Every call: check `stop_reason` (`refusal`, `max_tokens`) before reading content; on failure, use the code fallback.
- Every call wrapped in `traceable()` (LangSmith) and counted against the daily spend cap before it is sent.
- Concurrency limit (Redis semaphore) across instances.

### 5.6 Explain 🟢
- Input: packages with only the fields the model needs (short keys), the user's preferences, budget.
- Output: `PackageExplanation[]`, streamed.
- `grounding.ts`: drop a claim if any `source_fields` path is missing, or if any number in `text` doesn't equal a number in the cited fields (±1 for rounding).
- Fallback: bullets generated from `score_breakdown` ("Cheapest total: $2,410", "1 stop, 9h40m").

### 5.7 Refinement 🟢
- Chips → fixed deltas in `deltas.ts`:
  | Chip | Delta |
  |---|---|
  | `cheaper_hotel` | `scale hotel.max_price_per_night_usd 0.8`; if unset, `set` it to 80% of the cheapest hotel shown (or in the results) |
  | `better_hotel` | `hotel.min_rating` + 0.5 (max 5), and remove any hotel price cap |
  | `fewer_stops` | `flight.max_stops` − 1 (min 0) |
  | `shift_dates_earlier` / `_later` | both dates ∓/± 1 day |
  | `more_activities` | `activities.max_per_day` + 1 (max 6) |
- Free text → `parse-delta.ts`: one LLM call (structured output, text wrapped as data), output `ConstraintDelta` with `path` limited to `DeltaPath`. Not understood → `400 "Couldn't apply that, try a chip"`. Eval set: `evals/parse-delta.json`.
- `applyDelta(constraints, delta)` is a pure function with bounds checks: dates valid, not past, within 365 days; budget $100–$100,000; field ranges from the schema; `scale` only on set values, factor 0–10. It reports `changed: false` when nothing differs.
- `POST …/refine` returns `202 {delta, changed}` and always emits `refine_applied`. When nothing changed, current packages stay and no rerun starts. One refinement at a time per session (Redis lock; also requires status `awaiting_selection`); at most 10 changed deltas per session.

**Branch invalidation:**
| Delta path prefix | Re-search | Re-optimize + re-explain |
|---|---|---|
| `budget.` | none | yes |
| `hotel.` | hotels (cache first) | yes |
| `flight.` | flights (cache first) | yes |
| `activities.` | activities (cache first) | yes |
| `dates.` | all | yes |

Only date changes alter search keys, so "re-search" for the other prefixes re-reads the same cache entries (a provider call only if the entry expired). Categories a delta doesn't touch reuse the session's stored results from the option store, so a hotel chip makes zero flight or activity calls. Packages identical to the previous round keep their explanations without an LLM call. A refinement runs as a new round in the event stream (from its `refine_applied` event), so restart recovery works for refinements the same way as for the first run.

### 5.8 Session store & events 🟢
- `session:{id}` → `SessionRecord` JSON, TTL 24 h.
- `events:{id}` → Redis Stream; every emitted event is `XADD`ed. SSE handler reads from `Last-Event-ID` (or 0) and then blocks for new entries, so events are never lost and any instance can serve the stream.
- Orchestrator writes are idempotent per step; on restart a session in `searching` is re-run from cached results.

### 5.9 Extension 🟢
- **Service worker** (`TripController`) owns API calls and the SSE connection. It reduces events into a `TripState` in `chrome.storage.session` and keeps the stream open only while the server is working (searching, explaining, refining); `awaiting_selection`, `budget_advice` and `error` close it, and a refinement reopens it from the stored `Last-Event-ID`. Reconnects back off 1, 2, 4, 8 s. If Chrome stops the worker, the next start (or popup open) resumes. SSE uses `fetch`, since `EventSource` can't send the install token.
- **Popup** renders from storage via `storage.onChanged`, so it can close and reopen freely; it sends commands (`start`, `prefetch`, `refine`, `select`, `reset`) as runtime messages.
- **TripForm**: validation with the shared schema, draft in `chrome.storage.local`, prefetch 800 ms after origin, destination, dates and travelers are valid (identical prefetches sent once a minute).
- **PackagesView**: cards (totals against the current budget, flight/hotel/activities, explanation filling in as it streams), degraded banners, budget-advice and error views; during a refinement only the card parts the delta affects show as updating.
- **RefineBar**: six chips + text box (≤ 200 chars); shows the applied delta's reason and the refinement count; disabled while working and after 10.
- **MyTrips**: IndexedDB list and detail; links open with `chrome.tabs.create`; mark booked; delete; "Plan another trip" clears the trip and draft.
- Errors carry `refinable`: the refine bar stays available only when a refinement can fix the cause, and "Try again" appears only for retryable errors.
- React rendering only; URLs checked against the shared allowlist (`isAllowedBookingUrl` in `packages/schema`) before rendering as links.
- Manifest: `permissions: ["storage"]`, `host_permissions: ["https://api.travellite.dev/*"]`.

## 6. API 🟢

All routes: `Authorization: Bearer <install_token>`, JSON schema validation, per-token and per-IP rate limits.

| Method & path | Body | Response |
|---|---|---|
| `POST /v1/install` | `{extension_version}` | `{install_token}` (signed, rotatable) |
| `POST /v1/prefetch` | `{origin, destination, departure_date, return_date, date_flex_days, travelers}` | `202` |
| `POST /v1/sessions` | `VacationConfig` | `201 {session_id, stream_url}` |
| `GET /v1/sessions/:id/events` | — (SSE, `Last-Event-ID`) | event stream |
| `POST /v1/sessions/:id/refine` | `{chip: RefineChip} \| {text: string ≤200}` | `202` |
| `POST /v1/sessions/:id/select` | `{package_id}` | `200 SavedItinerary` |
| `GET /health` | — | `{status: "ok"}` |

Session routes return `404` unless the session's `install_id` matches the token.

**Events (SSE `event:` names):**
| Event | Data |
|---|---|
| `results` | `{category, count}` |
| `degraded` | `{category, error_kind}` |
| `packages` | `TripPackage[]` |
| `explanation` | `PackageExplanation` |
| `budget_advice` | `BudgetAdvice` |
| `awaiting_selection` | `{}` |
| `refine_applied` | `{delta, changed: boolean}` |
| `error` | `{code: ErrorCode, message, retryable}` |

## 7. Failure Handling 🟢

| Failure | Behavior |
|---|---|
| Provider timeout / 429 / 5xx | 1 retry, then `degraded` for that category |
| Provider breaker open | Cache if within TTL, else `degraded` |
| Malformed provider items | Dropped, counted |
| Flights or hotels degraded | `error` naming the category and cause (`core/diagnose.ts`); a package needs both. Provider detail (status, provider message) is logged, never sent |
| — provider refused access (401/403) | `PROVIDER_ACCESS`, "Hotel search isn't available: the hotel provider hasn't enabled access for this account." Not retryable or refinable; session `failed` |
| — provider found nothing (400/404/422) | `NOT_FOUND`, "No flights found from ATL to Amsterdam for Nov 15–17." Refinable (e.g. dates); session stays open |
| — timeout / 429 / 5xx / unreadable | Retryable, e.g. "The flight search timed out." Session `failed` |
| No flight or hotel passes the non-budget constraints | `error NOT_FOUND` naming the constraint(s) the closest option misses and the best value available, e.g. "No hotels rated 4.5+ (the highest rated is 4.2)." Refinable; status `awaiting_selection` |
| Flights and hotels never share dates | `error NOT_FOUND`, refinable |
| No package fits budget | `budget_advice` with the cheapest flight + hotel, their split, nights and any non-default filters; no LLM call; status `awaiting_selection` |
| Activities degraded | Packages without activities, plus a warning naming the cause |
| LLM error / refusal / max_tokens | Code-generated bullets |
| Claim fails grounding | Claim dropped |
| Free-text delta unparseable | "Couldn't apply that, try a chip" |
| Spend cap reached | Code-generated bullets, no LLM call (same as any LLM failure; no `error` event, since the packages are still usable) |
| SSE disconnect | Client resumes from `Last-Event-ID` |
| Instance restart mid-run | Session re-run from cached results |

## 8. Security 🟢

| Control | Implementation |
|---|---|
| Identity | Signed install token (HMAC, rotatable key); session bound to `install_id` |
| Abuse | Rate limits per token/IP per route; global daily spend cap → circuit breaker |
| Input | Fastify JSON schemas; enums; length caps; server-side re-validation |
| Output (extension) | React only; URL allowlist (`https:` + provider domains) |
| Booking links | Resolved server-side from option IDs |
| Prompt injection | Untrusted text in `<data>` blocks; schema-limited outputs; grounding validator |
| Origin | SSE route checks `Origin: chrome-extension://<id>` |
| Secrets | Secret manager; never in the extension |
| Egress | Allowlist: provider hosts, Anthropic API |
| Errors | Clients receive `ErrorCode` only |
| Privacy | Session TTL 24 h, deleted on select; traces redacted; retention 30 days |

## 9. Observability 🟢
- One LangSmith trace per session (`traceable()`), spans: `search.{provider}`, `optimize`, `explain`, `refine`, `parse_delta`.
- Span tags: `cache_hit`, `degraded`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cost_usd`.
- Metrics (OpenTelemetry → dashboard): p50/p95 per stage, cost/session, spend vs cap, cache hit rates, provider error rates and breaker state, refinements/session, selection rate by label.
- Redaction: no destination + dates + install ID together in traces; user free text hashed.

## 10. Testing Strategy 🟢

| Level | Scope |
|---|---|
| Unit | constraints, optimizer (budget math, dates, labels, dedupe), deltas, grounding, adapters (fixtures), auth, rate limits |
| Integration | full session against fixtures + mocked LLM; refine branches; SSE resume; restart recovery |
| Eval (CI) | ~30 scenarios: optimizer correctness, explanation schema validity, groundedness (LLM judge with rubric), delta parsing accuracy; fails on regression |
| E2E | 50 beta sessions across destinations; network drop; popup close; provider outage |
| Load | 100 concurrent sessions against fixtures (k6) |

---

# PART 2 — 🔵 FULL ADDITIONS

Everything in Part 1 stays. FULL adds the components below; the optimizer, deltas, sessions and events are reused.

## 11. Full System Architecture 🔵

```
                     ┌─────────────── OFFLINE ───────────────┐
                     │ Knowledge pipeline (Batch API)        │
                     │ → human review → Postgres (versioned) │
                     │ Entry requirements (authoritative)    │
                     └──────────────────┬────────────────────┘
                                        │ read
 form + description ─┬─▶ prefetch       ▼
                     ▼
            [LLM] Intent → constraints patch           (F11)
                     ▼
       ┌──── MVP core: search → optimizer → packages ────┐
       └──────────────────────┬──────────────────────────┘
                              ▼
            [code] Schedule builder → [LLM] narrate      (F10)
                              ▼
            select → itinerary (with schedule) → (opt) price watch (F15)
                              ▲
            refine (delta) ───┘
 side channel: question → [LLM agent ≤4 steps, read-only] → answer / proposed delta (F14)
```

## 12. Pipeline Changes 🔵

```
submit
  1a. extractIntent(config, description, profile)   LLM, parallel with prefetch   (F11)
  1b. buildConstraints(config) + apply intent patch
  2.  search                                          unchanged
  3.  optimize (+ area scoring from profile, pace)    extended                      (F12)
  4a. buildSchedule(package) per package              code                          (F10)
  4b. narrate(schedules, packages)                    replaces explain()            (F10)
  5.  awaiting_selection
  +   ask(question) → agent                           side channel                  (F14)
  +   select → optional watch                                                       (F15)
```

## 13. Additional Schemas 🔵

```ts
// F11
interface TripRequest extends VacationConfig { description?: string; passport_country?: CountryCode }
interface InterpretedIntent {
  constraints_patch: ConstraintDelta;
  pace: "slow" | "moderate" | "packed";
  avoid: AvoidTag[];                     // "crowds" | "early_starts" | "long_walks" | ...
  must_include?: string[];
  summary: string;
  confidence: "high" | "low";
}

// F12
interface DestinationProfile {
  city_id: CityId;
  version: string;
  reviewed_by: string;
  areas: { id: AreaId; name: string; centroid: { lat: number; lng: number };
           tags: Preference[]; good_for: string[];
           typical_hotel_per_night_usd: { p25: number; p50: number; p75: number } }[];
  seasonal_notes: { month: number; note: string }[];
}

// F13
interface EntryRequirement {
  destination_country: CountryCode;
  passport_country: CountryCode;
  requirement: "none" | "evisa" | "visa_on_arrival" | "visa_required";
  source_url: HttpsUrl;
  checked_at: ISODate;
}

// F10
interface ActivityAttrs {               // extends MVP ActivityAttrs
  tags: Preference[];
  duration_min: number;
  opening_hours?: { day: 0|1|2|3|4|5|6; open: HHMM; close: HHMM }[];
}
interface DaySchedule {
  date: ISODate;
  area_id?: AreaId;
  slots: { start: HHMM; end: HHMM;
           kind: "arrival" | "activity" | "free" | "meal" | "departure";
           activity_id?: string; travel_min_from_prev?: number;
           flags?: ("check_hours")[] }[];
}
interface Itinerary { package_id: string; days: DaySchedule[];
                      feasibility: { ok: boolean; issues: string[] } }
interface ItineraryNarrative {
  package_id: string;
  days: { date: ISODate; title: string; notes: Claim[] }[];
  tradeoff_summary: Claim[];
}

// F14
interface AgentAnswer {
  answer: string;
  citations: { tool: string; ref: string }[];
  proposed_delta?: ConstraintDelta;
}

// F15
interface PriceWatch {
  id: string; install_id: string; option_ids: string[];
  baseline_total_usd: number; threshold_pct: number; expires_at: ISODateTime;
}
```

`SessionRecord` gains: `intent?: InterpretedIntent`, `itineraries?: Itinerary[]`, `narratives?: ItineraryNarrative[]`, `questions_asked: number`.

## 14. Components 🔵

### 14.1 Day-by-day itinerary (F10) — release 1.5
**Prerequisite:** activity provider returns coordinates, duration and opening hours for top destinations.
- `schedule.ts` (code):
  1. Cluster activities by location (greedy, radius ~2 km), one main cluster per day.
  2. Day 1 starts 2 h after `arrive_at`; last day ends 3 h before `return_depart_at`.
  3. Order by opening hours, then nearest-neighbor distance; travel time = haversine × 1.4 at 20 km/h (a maps API can be swapped in later).
  4. Insert meal and free slots according to pace.
  5. Feasibility: hours respected, no overlaps, travel ≤ 60 min per hop → `feasibility.issues`.
- `narrate.ts` (LLM): one call for all packages, streamed per day; replaces `explain()`. Grounding validator extended to `activity_id` citations.
- Fallback: plain timeline from `DaySchedule`.
- New events: `schedule`, `narrative`.

### 14.2 Free-text trip description (F11) — release 1.5
- `extract-intent.ts`: one LLM call; input = form + description + area names/tags (if a profile exists); output `InterpretedIntent` with enum-limited paths and tags.
- Runs in parallel with prefetch; form fields override text on conflict.
- `summary` shown as an editable chip; `confidence: "low"` asks the user to confirm before search.
- `POST /v1/sessions/:id/intent {summary_edits}` re-runs from step 1.
- New event: `intent`.

### 14.3 Destination knowledge (F12) — release 1.6
- Offline job: build Batch API requests per destination from provider data + curated sources → draft `DestinationProfile`.
- Review tool (internal page): approve/edit/reject; only approved versions are served.
- Storage: Postgres `destination_profiles (city_id, version, data jsonb, reviewed_by, published_at)`; API caches the current version in Redis.
- Optimizer: `hotel_location` blends distance to the activity centroid with area tag match.
- Monthly refresh; unreviewed drafts never reach users.

### 14.4 Entry requirements (F13) — release 1.6
- Loaded from an authoritative dataset into Postgres `entry_requirements`; refreshed on a schedule; never LLM-generated.
- Shown in PackagesView when `passport_country` is set, with source link, `checked_at` and a "verify before travel" notice.

### 14.5 Trip Q&A assistant (F14) — release 1.7
- Anthropic SDK tool runner (`client.beta.messages.toolRunner` with Zod tools), model `claude-haiku-5-5`, effort low, strict tool schemas.
- Read-only tools: `get_destination_profile`, `get_entry_requirement`, `search_activities` (cache-first), `get_session_packages`.
- Hard cap of 4 tool steps; per-session cap of 5 questions; counted against the spend cap.
- Returns `AgentAnswer`; a `proposed_delta` is shown as a confirm button that calls `/refine` (normal validation path). The agent can't write state.
- Out-of-scope questions: fixed reply.
- `POST /v1/sessions/:id/ask {question ≤300}` → `AgentAnswer`; event `agent_answer`.

### 14.6 Price watch (F15) — release 2.0, optional
- `POST /v1/watches {session_id, package_id, threshold_pct}` (created at select time, since sessions are deleted after selection) → `PriceWatch` in Postgres.
- Scheduled worker (BullMQ repeatable job) re-prices every 12–24 h with its own provider rate budget; cache-first.
- Extension polls `GET /v1/watches/updates` via `chrome.alarms` (no push infrastructure required).
- `DELETE /v1/watches/:id`; watches expire at departure.

## 15. Orchestration in FULL 🔵
The main flow stays a plain TypeScript orchestrator. Move to LangGraph only if one of these appears: steps after selection (multi-leg trips, booking follow-ups), a multi-turn assistant sharing state with the main flow, or runs long enough that checkpoint-resume beats a rerun.

## 16. Cost & Latency 🔵

| | 🟢 MVP | 🔵 FULL |
|---|---|---|
| LLM calls (typical session) | explain ×(1 + refinements), 0–2 delta parses | + intent, narrate replaces explain, 0–1 Q&A (≤4 steps) |
| Approx LLM cost (excl. thinking) | ~$0.0015 | ~$0.005–0.008 |
| Packages visible | ~0.5–3 s | ~1–3.5 s |
| Session complete | ~3–6 s | ~5–10 s (streamed) |
| Offline | — | Batch API, per destination per month |

## 17. Failure Handling Additions 🔵

| Failure | Behavior |
|---|---|
| Intent extraction fails / low confidence | Form-only constraints / ask to confirm |
| No destination profile | Distance-only scoring |
| Missing opening hours | `check_hours` flag |
| Feasibility issues | Shown with a fix chip |
| Narration fails | Plain timeline |
| Agent hits step cap | Partial answer + notice |
| Watch provider failure | Skip this cycle; retry next |

## 18. Security & Privacy Additions 🔵
- Description (≤500) and questions (≤300) are length-capped, wrapped as data, and can only produce enum-limited outputs.
- Agent tools are read-only; state changes require user confirmation and go through `/refine`.
- Entry requirements and published profiles are never served without source/review.
- Price watches store option IDs, totals, threshold and install ID only; opt-in; expire at departure.
- Free text hashed in traces; privacy policy updated per release.

## 19. Evaluation Additions 🔵

| Suite | Release | Measures |
|---|---|---|
| Schedule feasibility | 1.5 | deterministic checks on fixtures |
| Narrative groundedness | 1.5 | LLM judge with rubric |
| Intent extraction | 1.5 | ~50 labeled descriptions → constraint accuracy, false-avoid rate |
| Knowledge spot checks | 1.6 | sample per refresh |
| Q&A | 1.7 | answer accuracy, citation validity, step count, out-of-scope refusal |
