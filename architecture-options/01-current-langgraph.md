# Architecture A: Current Spec (LangGraph Pipeline)

**Status:** As specified in `Specs/` and `app-rough-idea/`, documented as-is  
**Orchestration:** LangGraph.js state graph, 4 nodes in sequence  
**Purpose of this doc:** Baseline for comparison. Known issues are listed at the end and are not fixed here.

---

## 1. Overview

The user fills in a form. A LangGraph pipeline generates a plan, fetches flights, hotels and activities in parallel, has Claude write pros and cons for the top 3 of each, then pauses for approval. Approved selections become booking links that the user follows to book manually.

Each category is chosen independently: the top-ranked flight, hotel and activities are presented together but are never optimized as a combination.

---

## 2. Architecture Diagram

```
┌──────────────────────────────────────────┐
│ Browser Extension (MV3, TypeScript)      │
│  popup: InputForm → StreamingProgress    │
│         → ApprovalModal → Itinerary      │
│  background.js: WebSocket, IndexedDB     │
└───────────────┬──────────────────────────┘
                │ POST /plan  ·  WSS /stream/{id}  ·  POST /approve
┌───────────────▼──────────────────────────┐
│ Fastify (Node)                           │
│                                          │
│  LangGraph                               │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Planner │─▶│ Executor │─▶│ Reviewer │─┼─▶ Approval (pause)
│  │  (LLM)  │  │ parallel │  │ 9× LLM   │ │
│  └────┬────┘  └────┬─────┘  └──────────┘ │
│       │            │                     │
│  inMemorySessions{} · Redis (plan, 24h)  │
└───────┼────────────┼─────────────────────┘
        ▼            ▼
     Claude     Amadeus · Booking.com · TripAdvisor
```

---

## 3. Graph

```
START → planner → executor → reviewer → approval → END (awaiting_approval = true)
```

| Node | LLM | Does |
|---|---|---|
| `planner` | 1 call | Task list + budget allocation (%), visa/insurance flags. Redis cache keyed `plan:{destination}:{dateRange}`, 24h |
| `executor` | none | `Promise.all` over 3 providers, normalize to `Option`, top 20 each, fallback to default results on error |
| `reviewer` | 9 calls, **sequential** | For each category × top 3 options: pros, cons, recommended, rationale. Streams each result. Forces option[0] `recommended = true` |
| `approval` | none | Builds `ApprovalState` from top option per category, saves to memory/DB, broadcasts `awaiting_approval` |

---

## 4. Data Schemas

```ts
interface VacationConfig {
  destination: string;
  departure_date: ISO8601;
  return_date: ISO8601;
  budget_usd: number;          // 100–100,000
  travelers: number;           // 1–20
  preferences: string[];       // free text or multi-select (docs disagree)
}

interface TravelliteState {
  session_id: string;
  created_at: ISO8601;
  vacation_config: VacationConfig;
  plan: {
    tasks: { id: string; category: string; status: "pending" | "done" }[];
    budget_allocation: { flights: number; accommodations: number; activities: number };
  } | null;
  results: { flights?: Option[]; accommodations?: Option[]; activities?: Option[] };
  analysis?: Record<string, OptionAnalysis>;
  approval?: ApprovalState;
  awaiting_approval?: boolean;
  from_cache?: boolean;
}

interface Option {
  id: string;
  category: "flights" | "accommodations" | "activities";
  title: string;
  price: number;               // basis undefined (total vs per night vs per person)
  rating: number;
  url: string;
  pros?: string[];
  cons?: string[];
  recommended?: boolean;
}

interface OptionAnalysis {
  option_id: string;
  pros: string[];
  cons: string[];
  recommended: boolean;
  rationale: string;
}

interface ApprovalState {
  pending_bookings: { flight?: Option; accommodation?: Option; activities?: Option[] };
  approval_status: Record<"flight" | "accommodation" | "activities",
                          "pending" | "approved" | "rejected">;
  approved_selections: {
    flight?: { url: string; summary: string };
    accommodation?: { url: string; summary: string };
    activities?: { url: string; summary: string }[];
  };
}
```

---

## 5. API & Events

| Endpoint | Purpose |
|---|---|
| `POST /plan` | Validate config, create session ID, start graph (fire-and-forget), return `{session_id, ws_url}` |
| `WSS /stream/{session_id}` | Attach socket to `inMemorySessions[id].ws` |
| `GET /session/{id}` | Return current state (for resume) |
| `POST /session/{id}/approve` | `{approved, category}` → mark status, return `approved_selections` |

WebSocket events: `node_start`, `token` (one per token), `node_end`, `analysis`, `awaiting_approval`, `error`.

---

## 6. LLM Calls & Cost

| Call | Count | Approx tokens (in / out) |
|---|---|---|
| Planner | 1 (0 on cache hit) | 300 / 300 |
| Reviewer | 9 | 350 / 250 each |
| **Total** | **10** | **~3,450 / 2,550** |

Model is not specified in the docs. Estimates exclude thinking tokens:

| Model | Per session |
|---|---|
| Claude Sonnet 5.5 ($2 / $10 per MTok) | ~$0.032 (over the $0.025 target) |
| Claude Haiku 5.5 ($0.10 / $0.50 per MTok) | ~$0.0016 |

---

## 7. Latency (estimated)

| Stage | Time |
|---|---|
| Planner LLM | 1.5–3s |
| Executor (slowest provider, 10s timeout) | 1–3s, up to 10s |
| Reviewer (9 sequential calls) | 9–18s |
| **End to end** | **~12–24s** vs 8s target |

---

## 8. State & Scaling

- MVP: sessions in process memory, socket bound to one process.
- Scale plan: move state to Redis, add sticky sessions, Celery queue, in-process rate limiter, Postgres logs.

---

## 9. Known Issues

From the architecture review. Numbers refer to the 52-item change list.

| Area | Issue | Change # |
|---|---|---|
| Latency | Reviewer makes 9 sequential calls | 14 |
| Latency | Planner on critical path though executor ignores its output | 11 |
| Latency | Events emitted before the WebSocket connects are lost; `/plan` never populates `inMemorySessions` | 32 |
| Cost | Planner LLM call isn't needed | 11 |
| Cost | Plan cache key omits budget, travelers, preferences | 11 |
| Cost | Prompt caching confused with response caching; `cache_key` param doesn't exist | 17 |
| Cost | "Return ONLY JSON" + 3 retries instead of structured outputs | 16 |
| Quality | Categories optimized independently; no cross-category tradeoffs | (Arch B) |
| Quality | LLM `recommended` overridden by code; no ranking defined | 12 |
| Quality | Price basis undefined, so total cost is wrong | 3 |
| Scale | State in memory; graph "pause" ends the run | 21, 31 |
| Scale | Sticky sessions break `/approve` across pods | 33 |
| Scale | Celery is Python; backend is Node | 8 |
| Scale | Rate limiter never processes the queue, and is per pod | 27 |
| Security | Unauthenticated endpoints trigger paid calls | 38, 39 |
| Security | `innerHTML` with LLM/provider text; unchecked `href` | 43 |
| Security | `/approve` uses unvalidated `category` as an object key | 41 |
| Security | Privacy statement contradicts server-side storage and tracing | 6, 49 |
| Security | Unused manifest permissions | 44 |
