# Architecture B: MVP (Joint Packages + Refinement Deltas)

**Status:** Recommended for MVP  
**Orchestration:** Plain TypeScript orchestrator + Anthropic SDK. No LangGraph.  
**Scope:** Fixes from the 52-item change list, plus joint packages, refinement deltas, speculative prefetch and flexible dates (±2 days).

---

## 1. Overview

The user fills in a form. Search starts while they are still typing. On submit, code builds a constraint spec, searches all providers in parallel, and a **joint optimizer** scores whole trip combinations (flight + hotel + activities) against the **total** budget. The result is 2–3 complete packages ("Best value", "Best location", "Upgrade"). One LLM call explains the tradeoffs between them.

The user picks a package or refines it. Refinements ("cheaper hotel", "different dates") become **constraint deltas** that re-run only the affected branch, so a change takes 1–2s instead of a full rerun.

**Division of labor:** code ranks, optimizes and does all arithmetic. The LLM explains, and translates free-text refinements into deltas.

---

## 2. Architecture Diagram

```
┌────────────────────────────────────────────────────────────┐
│ Browser Extension (MV3, React/TS)                          │
│  InputForm ──(fields filled)──▶ prefetch                   │
│  Packages view ◀── SSE events      Refine chips / text box │
│  Itinerary (IndexedDB, owned by client after selection)    │
└──────┬───────────────────────┬──────────────────┬──────────┘
       │ POST /prefetch        │ POST /sessions   │ POST /refine · /select
┌──────▼───────────────────────▼──────────────────▼──────────┐
│ Fastify (Node, stateless pods)   auth: install token       │
│                                                            │
│  Orchestrator (plain TS)                                   │
│  ┌──────────┐  ┌─────────────┐  ┌───────────┐  ┌────────┐  │
│  │Constraint│─▶│ Search      │─▶│ Joint     │─▶│Explain │  │
│  │ builder  │  │ (parallel,  │  │ optimizer │  │ 1× LLM │  │
│  │  (code)  │  │  cached)    │  │  (code)   │  │ Haiku  │  │
│  └──────────┘  └─────────────┘  └───────────┘  └────────┘  │
│        ▲                                                   │
│        └── Refine: delta → rerun affected branch only      │
│                                                            │
│  Provider adapters: timeout · 1 retry · breaker · Zod      │
└──────┬───────────────────────┬─────────────────────────────┘
       ▼                       ▼
  Redis: sessions, event       Amadeus · Booking · TripAdvisor
  streams, caches, rate        Claude Haiku 5.5
  limits, spend counter
```

---

## 3. Pipeline

```
[prefetch]  destination + origin + dates entered → warm flight/hotel caches (no LLM)
     │
submit
     ▼
1. buildConstraints(config)          code   <1ms
2. search(constraints)               code   parallel per provider, cached, 2.5s timeout
     flights: date grid ±flex_days → keep best 2–3 date pairs
     hotels:  per kept date pair
     activities: once
3. optimize(results, constraints)    code   <50ms  → 2–3 packages
4. explain(packages)                 LLM    1 Haiku call, structured output, streamed
5. emit awaiting_selection
     │
     ├── refine(chip | text) → delta → rerun affected branch → 3 → 4
     └── select(package_id) → itinerary links → client stores, server deletes
```

---

## 4. Data Schemas

```ts
// ---- Input ----
interface VacationConfig {
  origin: IATA;                         // new: replaces detectOrigin()
  destination: CityId;                  // validated against city list
  departure_date: ISODate;
  return_date: ISODate;
  date_flex_days: 0 | 1 | 2;            // new
  budget_usd: number;                   // total for the trip
  travelers: number;
  preferences: Preference[];            // enum, not free text
}

type Preference = "beach" | "museums" | "food" | "nightlife" | "outdoors"
                | "shopping" | "family" | "relaxed_pace";

// ---- Constraints (what search + optimizer read; what deltas edit) ----
interface Constraints {
  dates: { depart: ISODate; return: ISODate; flex_days: number };
  budget: { total_usd: number; tolerance_pct: number };   // e.g. 5
  flight: { max_stops: number; max_price_usd?: number;
            earliest_depart?: HHMM; latest_arrive?: HHMM };
  hotel:  { min_rating: number; max_price_per_night_usd?: number;
            area?: AreaId; max_km_from_center?: number };
  activities: { interests: Preference[]; max_per_day: number;
                max_price_each_usd?: number };
  travelers: number;
}

// ---- Normalized provider output ----
interface Option {
  id: string;                           // provider-prefixed, e.g. "amadeus:XYZ"
  category: "flight" | "hotel" | "activity";
  title: string;
  price: Money;
  price_basis: "total" | "per_night" | "per_person";   // new
  rating?: number;
  location?: { lat: number; lng: number };
  url: HttpsUrl;                        // allowlisted provider domain
  attrs: FlightAttrs | HotelAttrs | ActivityAttrs;
}
interface Money { amount: number; currency: "USD" }

interface FlightAttrs   { depart_at: ISODateTime; arrive_at: ISODateTime;
                          return_depart_at: ISODateTime; stops: number;
                          duration_min: number; carrier: string }
interface HotelAttrs    { checkin: ISODate; checkout: ISODate; nights: number;
                          area?: AreaId; km_from_center?: number }
interface ActivityAttrs { tags: Preference[]; duration_min?: number }

// ---- Optimizer output ----
interface TripPackage {
  id: string;
  label: "best_value" | "best_location" | "upgrade";
  flight: Option;
  hotel: Option;
  activities: Option[];
  total_usd: number;                    // computed in code from price_basis
  score: number;
  score_breakdown: { cost_fit: number; flight_convenience: number;
                     hotel_location: number; rating: number; pref_match: number };
}

// ---- LLM output (structured outputs schema) ----
interface PackageExplanation {
  package_id: string;                   // must be one of the input IDs
  headline: string;                     // ≤ 80 chars
  pros: Claim[];                        // 2–3
  cons: Claim[];                        // 1–3
}
interface Claim { text: string; source_fields: string[] }  // grounding

// ---- Refinement ----
type RefineChip = "cheaper_hotel" | "better_hotel" | "fewer_stops"
                | "shift_dates_earlier" | "shift_dates_later" | "more_activities";

interface ConstraintDelta {
  ops: { path: string;                  // e.g. "hotel.max_price_per_night_usd"
         op: "set" | "scale" | "add" | "remove";
         value: unknown }[];
  reason: string;
}

// ---- Server session (Redis, TTL 24h) ----
interface SessionRecord {
  id: string;
  install_id: string;                   // bound at creation
  status: "searching" | "awaiting_selection" | "refining" | "selected" | "failed";
  config: VacationConfig;
  constraints: Constraints;
  delta_history: ConstraintDelta[];     // max 10 refinements
  results: Record<"flight" | "hotel" | "activity",
                  { options: Option[]; fetched_at: ISODateTime; degraded: boolean }>;
  packages: TripPackage[];
  explanations: PackageExplanation[];
  created_at: ISODateTime;
}
```

---

## 5. Joint Optimizer

**Inputs:** top 10 flights across kept date pairs, top 10 hotels per date pair, up to 20 activities.

**Hard constraints** (option is discarded if violated):
- `total_usd ≤ budget.total_usd × (1 + tolerance_pct/100)`
- Hotel dates match the flight's date pair
- Flight `stops ≤ max_stops`, hotel `rating ≥ min_rating`

**Score** (weights tuned with fixtures):
```
score = w1·cost_fit + w2·flight_convenience + w3·hotel_location + w4·rating + w5·pref_match
```
- `cost_fit`: how well the total uses the budget (penalize waste and overspend)
- `flight_convenience`: stops, duration, arrival hour
- `hotel_location`: distance to the activity centroid or the preferred area
- `pref_match`: overlap between activity tags and preferences

**Activities:** greedy selection by `pref_match / price` under the remaining budget, capped at `max_per_day × nights`.

**Packages:** search space is ~100 flight × hotel pairs, trivial to brute-force.
- `best_value`: highest `score / total_usd`
- `best_location`: highest `hotel_location` with `score` in the top quartile
- `upgrade`: highest `score` within budget
- Each package must differ from the others in flight or hotel.

**Budget breach:** if no combination fits, skip the LLM and return `budget_advice` (cheapest possible total, which category drives it, nearest dates that fit).

---

## 6. Refinement Deltas

| Input | Delta source | LLM |
|---|---|---|
| Chip (`cheaper_hotel`, etc.) | Fixed mapping in code | No |
| Free-text box ("closer to the beach") | 1 Haiku call → `ConstraintDelta` (structured output, paths limited to an enum) | Yes |

**Branch invalidation:**

| Delta path | Re-search | Re-optimize | Re-explain |
|---|---|---|---|
| `budget.*` | none | yes | yes |
| `hotel.*` | hotels (cache first) | yes | yes |
| `flight.*` | flights (cache first) | yes | yes |
| `activities.*` | activities (cache first) | yes | yes |
| `dates.*` | all | yes | yes |

Limits: max 10 refinements per session; a delta that changes nothing returns the current packages with a note.

---

## 7. API & Events

All requests use `Authorization: Bearer <install_token>` (signed, issued on install). Fastify JSON schema validation on every route.

| Endpoint | Body | Returns |
|---|---|---|
| `POST /v1/prefetch` | `{origin, destination, dates, flex}` | `202`. No LLM, rate-limited |
| `POST /v1/sessions` | `VacationConfig` | `{session_id, stream_url}` |
| `GET /v1/sessions/:id/events` | SSE, `Last-Event-ID` | event stream, replayed from Redis Stream |
| `POST /v1/sessions/:id/refine` | `{chip} \| {text}` | `202`, results via events |
| `POST /v1/sessions/:id/select` | `{package_id}` | `{itinerary}`. Server deletes the session after this |

Events: `results` (per category), `degraded`, `packages`, `explanation` (per package), `budget_advice`, `awaiting_selection`, `refine_applied`, `error`.

**Transport:** SSE from the service worker (simpler than WebSocket, built-in resume). Events fan out through Redis, so any pod can serve any request.

---

## 8. LLM Calls & Cost

Model: Claude Haiku 5.5 (`claude-haiku-5-5`), `effort: "low"`, structured outputs, small `max_tokens`. The system prompt and schema are kept stable and ≥512 tokens so they can be prompt-cached.

| Call | Count / session | Approx tokens (in / out) |
|---|---|---|
| Explain packages | 1 + 1 per refinement | 1,200 / 600 |
| Free-text delta | 0–2 | 400 / 100 |

Typical session (initial + 2 refinements, 1 free-text): **~$0.0015** at $0.10 / $0.50 per MTok, excluding thinking tokens.

**Spend controls:** per-install rate limit, global daily spend counter in Redis with a circuit breaker.

---

## 9. Latency (estimated, cache warm from prefetch)

| Stage | Time |
|---|---|
| Search on submit | 0–0.5s warm, ≤2.5s cold |
| Optimizer | <50ms |
| **Packages visible** (no explanation yet) | **~0.5–3s** |
| Explanation first token / complete | ~0.5–1s / 2–4s |
| **Session complete** | **~3–6s** |
| Chip refinement | 0.3–2.5s + re-explain 1–2s |

---

## 10. Failure Handling

| Failure | Behavior |
|---|---|
| Provider timeout / 5xx / 429 | 1 retry respecting `retry-after`, then `degraded` for that category |
| Malformed provider items | Dropped by Zod, count logged |
| Provider breaker open | Serve cache if <TTL, else `degraded` |
| All categories degraded | `error` with a retry option |
| LLM failure | Packages are still shown, using the code-generated `score_breakdown` as plain bullet points |
| Claim fails grounding check | That claim is dropped |
| Retry budget | One per session; SDK `maxRetries` = 1; no app-level LLM retries |

---

## 11. Security

- Signed install token; sessions bound to `install_id`; per-token and per-IP rate limits; global spend cap.
- Fastify JSON schemas on all routes, enum-only fields where possible.
- Booking URLs only from server-side option lookup; `https:` + provider-domain allowlist.
- Extension renders through React only, never `dangerouslySetInnerHTML`; minimal manifest (`storage` + API host).
- Provider text wrapped in delimiters in prompts and treated as data; LLM output schema-constrained.
- Secrets in a secret manager; outbound traffic restricted to provider and Anthropic hosts.
- Privacy: server holds session data ≤24h and deletes it after `select`; itinerary lives in the extension; traces redacted.

---

## 12. Observability & Evaluation

- One LangSmith trace per session via `traceable()`; spans for search, optimize, explain, refine. Tags: tokens, cost, cache hits, degraded.
- Metrics: p95 per stage, cost per session, cache hit rate, provider errors, refinements per session, package selection rate by label.
- Recorded provider fixtures make optimizer tests and evals deterministic.
- Eval set (~30 scenarios), run in CI: optimizer correctness (budget, dates), explanation schema validity, groundedness (LLM judge), delta-parsing accuracy.

---

## 13. Build Order (single developer, rough)

| Stage | Work (total ~16 dev-weeks solo; stages overlap when parallelized) |
|---|---|
| 1 | Shared Zod schemas, provider adapters + fixtures, Redis session store, auth |
| 2 | Search + caching + prefetch + flex dates, joint optimizer + tests |
| 3 | Explain call, SSE events, extension package view |
| 4 | Refinement (chips → free text), select/itinerary, rate limits, spend cap |
| 5–6 | Observability, eval set, E2E, deployment |

---

## 14. Out of Scope (Phase 1.5, see Architecture C)

Free-text trip description, day-by-day itinerary builder, offline destination knowledge, off-script Q&A agent, price watching.
