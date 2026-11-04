# Travellite Tasks

**Project:** Travel Planning Assistant (Browser Extension)  
**Format:** AI-Agent Optimized with Status Tracking  
**Version:** 2.0 (replaces the LangGraph task list, archived in `_archive-v1-langgraph/`)  
**Last Updated:** 2026-10-29  
**Requirements:** `requirements.md` · **Design:** `design.md`

Tasks are tagged 🟢 **MVP** or 🔵 **FULL**. All 🟢 tasks ship in release 1.0. 🔵 tasks start only after the **MVP → FULL gate** (below) is passed.

Effort: **S** = 1–2 days · **M** = 2–3 days · **L** = 3–5 days (single developer).

---

## Task Status Dashboard

```
🟢 MVP — Release 1.0  (~16 dev-weeks solo · ~8-week critical path)
M0  Foundation
├─ T0.1 [x] Monorepo setup                        S
├─ T0.2 [x] Shared schemas package                M
├─ T0.3 [x] Redis store: sessions, events, cache  M
├─ T0.4 [x] Install token, rate limits, spend cap M
├─ T0.5 [x] Extension scaffold (MV3)              S
└─ T0.6 [x] LLM client wrapper                    M
M1  Search
├─ T1.1 [x] Provider interface + resilience       M
├─ T1.2 [~] Flights adapter (flex dates)          L
├─ T1.3 [~] Hotels adapter                        M
├─ T1.4 [~] Activities adapter                    M
├─ T1.5 [x] Search cache + prefetch endpoint      M
└─ T1.6 [~] Fixture recorder                      S
M2  Planning core
├─ T2.1 [x] Constraint builder                    S
├─ T2.2 [x] Joint optimizer                       L
├─ T2.3 [x] Budget advice                         S
├─ T2.4 [x] Explain + grounding validator         M
└─ T2.5 [x] Orchestrator + SSE events             L
M3  Refinement & selection
├─ T3.1 [  ] Chip deltas + applyDelta              M
├─ T3.2 [  ] Free-text delta parser                M
├─ T3.3 [  ] Branch rerun                          M
└─ T3.4 [x] Select endpoint + session deletion    S
M4  Extension UI
├─ T4.1 [  ] Service worker: SSE + API client      M
├─ T4.2 [  ] TripForm + prefetch                   M
├─ T4.3 [  ] PackagesView                          L
├─ T4.4 [  ] RefineBar                             M
└─ T4.5 [  ] MyTrips + saved itineraries           M
M5  Quality & launch
├─ T5.1 [  ] Tracing + metrics dashboard           M
├─ T5.2 [  ] Eval suite in CI                      L
├─ T5.3 [  ] Integration + load tests              M
├─ T5.4 [  ] Deployment                            M
├─ T5.5 [  ] Privacy policy + store listing        S
└─ T5.6 [  ] Beta: 50 sessions                     L
MVP STATUS: 14/32 done · 4 partial
[~] = built and tested on synthetic fixtures; needs provider keys + a live recording

══════════ MVP → FULL GATE ══════════

🔵 FULL — Releases 1.5–2.0  (~8 dev-weeks solo + ~1.5 for optional 2.0)
R1.5  Itinerary + intent
├─ F1.1 [  ] Activity data enrichment              M
├─ F1.2 [  ] Schedule builder + feasibility        L
├─ F1.3 [  ] Narration + extended grounding        M
├─ F1.4 [  ] Itinerary UI                          M
├─ F1.5 [  ] Intent extraction                     M
├─ F1.6 [  ] Intent eval set                       M
└─ F1.7 [  ] Intent summary UI                     S
R1.6  Knowledge + entry requirements
├─ F2.1 [  ] Postgres + knowledge schema           S
├─ F2.2 [  ] Batch knowledge pipeline              L
├─ F2.3 [  ] Review tool                           M
├─ F2.4 [  ] Optimizer area scoring                M
└─ F2.5 [  ] Entry requirements                    M
R1.7  Trip Q&A
├─ F3.1 [  ] Read-only agent tools                 M
├─ F3.2 [  ] Bounded agent + /ask                  M
├─ F3.3 [  ] Q&A eval                              M
└─ F3.4 [  ] Q&A UI + confirm-delta flow           M
R2.0  Price watch (optional)
├─ F4.1 [  ] Watch store + endpoints               M
├─ F4.2 [  ] Re-pricing worker                     M
└─ F4.3 [  ] Extension notifications               S
FULL STATUS: 0/19
```

---

# 🟢 MVP — Release 1.0

## M0: Foundation

### T0.1: Monorepo setup 🟢
**Effort:** S · **Depends on:** none
```
✓ Git repo; npm workspaces: packages/schema, apps/api, apps/extension
✓ TypeScript strict; ESLint; Prettier; Vitest
✓ npm run dev starts the API on :3000; npm run build compiles all workspaces
✓ .env.example lists every required variable (no secrets committed)
✓ CI runs lint + typecheck + tests on every push
```
**Deliverables:** repo skeleton, CI workflow

### T0.2: Shared schemas package 🟢
**Effort:** M · **Depends on:** T0.1
```
✓ Zod schemas for every type in design.md §4 (VacationConfig, Constraints, Option,
  TripPackage, BudgetAdvice, PackageExplanation, Claim, ConstraintDelta, DeltaPath,
  SessionRecord, SavedItinerary, ErrorCode, SSE event payloads)
✓ TS types inferred from schemas; no duplicate interfaces anywhere
✓ JSON Schema exported for Fastify route validation
✓ Unit tests: valid/invalid samples per schema
```
**Deliverables:** `packages/schema`

### T0.3: Redis store 🟢
**Effort:** M · **Depends on:** T0.2
```
✓ sessions.ts: get/put/delete SessionRecord, TTL 24 h
✓ events.ts: append (XADD), read from ID, blocking tail (XREAD)
✓ cache.ts: get/set with TTL; option-by-ID lookup
✓ Works against local Redis (docker compose) and managed Redis
✓ Tests run on real Redis (DB 15); in-memory mocks don't implement streams correctly
✓ Tests: TTL expiry, event ordering, resume from ID
```

### T0.4: Install token, rate limits, spend cap 🟢
**Effort:** M · **Depends on:** T0.3
```
✓ POST /v1/install issues an HMAC-signed token; key rotation supported
✓ Auth hook rejects missing/invalid tokens (401)
✓ Rate limits per token and per IP, per route group (prefetch, sessions, refine)
✓ spend.ts: atomic daily counter; reserve-before-call; breaker trips at the cap
✓ Origin check helper for the SSE route
✓ Tests: forged token, rate limit exceeded, cap reached
```

### T0.5: Extension scaffold 🟢
**Effort:** S · **Depends on:** T0.1
```
✓ MV3 manifest: permissions ["storage"], host_permissions [API origin only]
✓ React popup + service worker build (Vite)
✓ First run calls /v1/install and stores the token in chrome.storage.local
✓ Loads unpacked with no console errors
```

### T0.6: LLM client wrapper 🟢
**Effort:** M · **Depends on:** T0.2, T0.4
```
✓ Anthropic TS SDK; model claude-haiku-5-5; effort "low"; maxRetries 1
✓ structured(schema, system, input) helper using structured outputs + Zod
✓ Streaming variant yielding validated partial objects
✓ System prompt block with cache_control; test asserts cache_read_input_tokens > 0
  on the second identical call
✓ Checks stop_reason (refusal, max_tokens) and returns a typed failure
✓ Reserves spend before each call; wrapped in traceable()
✓ Redis semaphore limits concurrent calls
✓ Untrusted text helper wraps input in <data> blocks
```

## M1: Search

### T1.1: Provider interface + resilience 🟢
**Effort:** M · **Depends on:** T0.2, T0.3
```
✓ SearchProvider<P> interface and ProviderError kinds (design.md §5.2)
✓ resilience.ts: 2.5 s timeout, ≤1 retry on 429/5xx with jitter + retry-after,
  circuit breaker (5 failures/60 s → open, half-open after 30 s)
✓ Shared Redis token bucket per provider
✓ Zod validation of raw responses; invalid items dropped and counted
✓ URL allowlist check during normalization
✓ Tests: timeout, retry once, breaker open/half-open, bad payload
```

### T1.2: Flights adapter (flex dates) 🟢
**Effort:** L · **Depends on:** T1.1
```
✓ Provider: Duffel (Amadeus Self-Service shut down 2026-07-17). Static bearer token,
  so no OAuth caching; Node fetch keeps connections alive
✓ Flex: the whole trip shifts ±flex_days (≤5 pairs, searched in parallel); best 3
  pairs kept by cheapest offer. Duffel has no cheapest-date endpoint, so each pair
  is a full offer request
✓ Option with FlightAttrs (airport-local times), price_basis "total"
✓ Sorted, top 10 across date pairs
✓ Fixture tests: normal, no results, invalid IATA, 429
☐ Live recording with a Duffel test token; confirm response shape matches
```

### T1.3: Hotels adapter 🟢
**Effort:** M · **Depends on:** T1.1
```
✓ Provider: Duffel Stays (test mode is self-serve; live needs Duffel's Go-Live review)
✓ Search per date pair; Option with HotelAttrs (nights, km_from_center, location)
✓ price_basis "total" (cheapest rate for the stay); non-USD converted with ECB rates
✓ Top 10 per date pair by rating, then price
✓ Fixture tests: normal, no availability, invalid city, 429, GBP conversion
☐ Live recording; confirm the search body and result shape against a real response
☐ Booking links: Duffel has no consumer booking page, so links go to a Google
  Hotels / Google Flights search for now. Decide before launch (see design §5.2)
```

### T1.4: Activities adapter 🟢
**Effort:** M · **Depends on:** T1.1
```
✓ Provider: Viator Partner API, Basic (affiliate) access, self-serve
✓ Option with ActivityAttrs (tag names mapped to Preference enum, duration)
✓ price_basis "per_person" (Viator "from" price)
✓ Top 20 by rating. Search results carry no coordinates; location left empty
✓ Fixture tests: normal, empty, 429, provider down (degraded)
☐ Confirm /products/search is open to Basic access (Viator's docs disagree)
```

### T1.5: Search cache + prefetch endpoint 🟢
**Effort:** M · **Depends on:** T1.2, T1.3, T0.4
```
✓ Cache keys and TTLs per design.md §5.3
✓ search(constraints) checks cache first, fetches misses in parallel
✓ POST /v1/prefetch warms flight + hotel caches, returns 202, never calls the LLM
✓ Prefetch has its own rate limit
✓ Test: session after prefetch makes zero provider calls for warmed categories
```

### T1.6: Fixture recorder 🟢
**Effort:** S · **Depends on:** T1.2
```
✓ Script records real provider responses (secrets stripped) into fixtures/
  (npm run fixtures:record -w @travellite/api)
✓ Adapters run in fixture mode via PROVIDER_MODE=fixture (the default)
✓ Fixture dates shift on replay, so recordings work for any travel dates
~ 12 destinations with budget-breach and degraded cases, currently synthetic
  (npm run fixtures:synth). Re-record live once keys exist
```

## M2: Planning core

### T2.1: Constraint builder 🟢
**Effort:** S · **Depends on:** T0.2
```
✓ buildConstraints(config) pure function with defaults from design.md §5.1
✓ relaxed_pace → max_per_day 1
✓ Tests: defaults, preference mapping
```

### T2.2: Joint optimizer 🟢
**Effort:** L · **Depends on:** T2.1, T1.6
```
✓ Totals computed from price_basis × nights × travelers (design.md §5.4)
✓ Hard constraints enforced; scoring with configurable weights
✓ Greedy activity fill under the remaining budget
✓ Labels best_value / best_location / upgrade; duplicates removed; 2–3 packages
✓ < 50 ms for 10 × 10 × 20 (benchmark test)
✓ Tests on fixtures: totals correct, dates match, nothing over budget,
  labels distinct, degraded category handled
```

### T2.3: Budget advice 🟢
**Effort:** S · **Depends on:** T2.2
```
✓ Cheapest total, driving category, nearest fitting date pair from cached grid
✓ Test: over-budget fixture returns advice, no LLM call made
```

### T2.4: Explain + grounding validator 🟢
**Effort:** M · **Depends on:** T0.6, T2.2
```
✓ explain(packages, prefs, budget) → PackageExplanation[] streamed
✓ Input trimmed to needed fields with short keys
✓ package_id constrained to input IDs
✓ grounding.ts drops claims with missing source_fields or mismatched numbers
✓ Fallback bullets from score_breakdown on any LLM failure
✓ Tests: valid output, hallucinated number dropped, refusal → fallback
```

### T2.5: Orchestrator + SSE events 🟢
**Effort:** L · **Depends on:** T1.5, T2.2, T2.3, T2.4, T0.3
```
✓ POST /v1/sessions validates, creates SessionRecord bound to install_id, starts run
✓ run-session.ts executes design.md §3 steps; every emit goes to the Redis event stream
✓ GET /v1/sessions/:id/events streams from Last-Event-ID; Origin checked
✓ Session routes 404 for a different install_id
✓ Restart recovery: sessions in "searching" re-run from cache
✓ Integration test: full session on fixtures + mocked LLM; disconnect/resume loses no events
```

## M3: Refinement & selection

### T3.1: Chip deltas + applyDelta 🟢
**Effort:** M · **Depends on:** T2.1
```
✓ Fixed delta per RefineChip (design.md §5.7)
✓ applyDelta pure, bounds-checked; returns changed: boolean
✓ Tests: each chip, no-op delta, invalid result rejected
```

### T3.2: Free-text delta parser 🟢
**Effort:** M · **Depends on:** T0.6, T3.1
```
✓ parse-delta.ts: one LLM call → ConstraintDelta, path limited to DeltaPath
✓ Text ≤ 200 chars, wrapped as data
✓ Unparseable → typed failure with "try a chip" message
✓ Tests: 15 sample phrases map to expected deltas (also added to the eval set)
```

### T3.3: Branch rerun 🟢
**Effort:** M · **Depends on:** T3.1, T2.5
```
✓ POST /v1/sessions/:id/refine accepts {chip} or {text}; ≤ 10 per session
✓ rerun-branch.ts re-searches only invalidated categories (cache first),
  then re-optimizes and re-explains
✓ Emits refine_applied with the delta
✓ Test: hotel chip triggers zero flight/activity provider calls; p95 ≤ 2.5 s on fixtures
```

### T3.4: Select endpoint + session deletion 🟢
**Effort:** S · **Depends on:** T2.5
```
✓ POST /v1/sessions/:id/select {package_id} → SavedItinerary with server-resolved URLs
✓ Session and event stream deleted after a successful response
✓ Tests: unknown package_id → 400; second select → 404
```

## M4: Extension UI

### T4.1: Service worker — SSE + API client 🟢
**Effort:** M · **Depends on:** T0.5, T2.5
```
✓ API client adds the token; typed with packages/schema
✓ SSE connection with Last-Event-ID resume and backoff (1, 2, 4, 8 s)
✓ Events written to chrome.storage.session; popup notified via runtime messages
✓ Manual test: close popup mid-session, reopen → state intact; drop network → resumes
```

### T4.2: TripForm + prefetch 🟢
**Effort:** M · **Depends on:** T4.1, T1.5
```
✓ Fields and validation per requirements F1
✓ Draft persisted on change and restored
✓ Debounced prefetch (800 ms) once origin/destination/dates are valid
✓ Keyboard accessible; WCAG AA contrast
```

### T4.3: PackagesView 🟢
**Effort:** L · **Depends on:** T4.1
```
✓ Package cards render as packages arrive; explanations fill in as they stream
✓ Shows totals, flight/hotel/activities, pros/cons, label
✓ Degraded banners per category; budget-advice view
✓ React rendering only; URLs checked against the allowlist before render
✓ Select button → T3.4 → MyTrips
```

### T4.4: RefineBar 🟢
**Effort:** M · **Depends on:** T4.3, T3.3
```
✓ Chips + text box (≤ 200 chars)
✓ Shows the applied delta text; disables after 10 refinements
✓ Loading state per affected card only
```

### T4.5: MyTrips + saved itineraries 🟢
**Effort:** M · **Depends on:** T3.4, T0.5
```
✓ SavedItinerary stored in IndexedDB on select
✓ List view; detail view with links (chrome.tabs.create)
✓ Mark as booked; delete trip
✓ "Plan another trip" resets the form
```

## M5: Quality & launch

### T5.1: Tracing + metrics dashboard 🟢
**Effort:** M · **Depends on:** T2.5
```
✓ One LangSmith trace per session with spans and tags from design.md §9
✓ OpenTelemetry metrics → dashboard (p95 per stage, cost/session, spend vs cap,
  cache hit rates, provider errors, breaker state, refinements, selection by label)
✓ Redaction verified by a test
✓ Alerts: spend > 80% of cap, provider error rate > 10%, p95 over target
```

### T5.2: Eval suite in CI 🟢
**Effort:** L · **Depends on:** T2.4, T3.2, T1.6
```
✓ ~30 scenarios from fixtures (incl. budget breach, degraded, flex dates)
✓ Graders: optimizer correctness (code), explanation schema validity (code),
  groundedness (LLM judge with a written rubric), delta parsing accuracy (code)
✓ Runs on every change to prompts, schemas, optimizer weights or model
✓ CI fails on regression vs the stored baseline
✓ Reports tokens, cost and latency per scenario
```

### T5.3: Integration + load tests 🟢
**Effort:** M · **Depends on:** T3.3, T3.4
```
✓ Full flow, refine branches, select, SSE resume, restart recovery
✓ k6: 100 concurrent sessions on fixtures; p95 targets met; no rate-limit leaks
```

### T5.4: Deployment 🟢
**Effort:** M · **Depends on:** T5.1
```
✓ Dockerfile (Node 20, non-root); ≥ 2 API instances behind a load balancer
✓ Managed Redis with persistence
✓ Secrets in the platform's secret manager; egress allowlist configured
✓ Auto-deploy from main after CI; /health checked
```

### T5.5: Privacy policy + store listing 🟢
**Effort:** S · **Depends on:** T5.4
```
✓ Privacy policy matches actual data handling (24 h sessions, deletion on select,
  local itineraries, redacted traces)
✓ Chrome Web Store data disclosure completed; minimal permissions justified
```

### T5.6: Beta — 50 sessions 🟢
**Effort:** L · **Depends on:** all M0–M5
```
✓ 5–10 users, ≥ 10 destinations
✓ Scenarios: happy path, refine chips, free-text refine, budget breach,
  provider outage, network drop, popup close
✓ Results documented against the MVP success metrics in requirements.md
```

---

## MVP → FULL Gate

All must hold before any 🔵 task starts:
```
✓ T5.6 meets the MVP success metrics
✓ T5.2 eval suite green in CI
✓ Activity data with coordinates + opening hours confirmed for top destinations
✓ Provider partner access confirmed for hotels and activities
```

---

# 🔵 FULL — Releases 1.5–2.0

## R1.5: Itinerary + Intent

### F1.1: Activity data enrichment 🔵
**Effort:** M · **Depends on:** gate
```
✓ Activities adapter returns coordinates, duration and opening hours where available
✓ Coverage report per destination; missing hours → check_hours flag
✓ Fixtures re-recorded
```

### F1.2: Schedule builder + feasibility 🔵
**Effort:** L · **Depends on:** F1.1
```
✓ schedule.ts per design.md §14.1 (clustering, day bounds, ordering, travel time, pace)
✓ Feasibility issues populated; fix chips mapped to deltas
✓ < 100 ms per package
✓ Deterministic eval: hours respected, no overlaps, travel ≤ 60 min/hop (≥ 98%)
```

### F1.3: Narration + extended grounding 🔵
**Effort:** M · **Depends on:** F1.2, T2.4
```
✓ narrate(schedules, packages) replaces explain(); streamed per day
✓ Grounding validator accepts activity_id citations
✓ Fallback: plain timeline
✓ Groundedness eval ≥ 95%
```

### F1.4: Itinerary UI 🔵
**Effort:** M · **Depends on:** F1.3, T4.3
```
✓ Day-by-day view per package; streaming narrative
✓ Feasibility issues with fix chips; check_hours flags shown
✓ SavedItinerary includes the schedule
```

### F1.5: Intent extraction 🔵
**Effort:** M · **Depends on:** gate, T0.6
```
✓ Optional description (≤ 500 chars) in TripRequest
✓ extractIntent → InterpretedIntent with enum-limited paths/tags
✓ Runs in parallel with prefetch; form overrides text on conflict
✓ Failure → form-only constraints
✓ Emits intent event
```

### F1.6: Intent eval set 🔵
**Effort:** M · **Depends on:** F1.5
```
✓ ~50 labeled descriptions with expected constraints
✓ Accuracy ≥ 90%; false-avoid rate tracked
✓ Added to CI
```

### F1.7: Intent summary UI 🔵
**Effort:** S · **Depends on:** F1.5, T4.2
```
✓ Editable summary chip; low confidence asks the user to confirm
✓ POST /v1/sessions/:id/intent re-runs from step 1
```

## R1.6: Knowledge + Entry Requirements

### F2.1: Postgres + knowledge schema 🔵
**Effort:** S · **Depends on:** gate
```
✓ Managed Postgres; migrations for destination_profiles and entry_requirements
✓ Current profile version cached in Redis
```

### F2.2: Batch knowledge pipeline 🔵
**Effort:** L · **Depends on:** F2.1
```
✓ Batch API job drafts DestinationProfile per destination (structured output)
✓ Inputs: provider data + curated sources; outputs stored as unpublished drafts
✓ Monthly schedule; cost report per run
```

### F2.3: Review tool 🔵
**Effort:** M · **Depends on:** F2.2
```
✓ Internal page to approve/edit/reject drafts; reviewer recorded
✓ Only approved versions served; rollback to a previous version
```

### F2.4: Optimizer area scoring 🔵
**Effort:** M · **Depends on:** F2.3, T2.2
```
✓ hotel_location blends centroid distance with area tag match
✓ Intent extraction receives area names/tags
✓ Destinations without a profile fall back to distance-only
✓ A/B: area-aware vs distance-only selection rate
```

### F2.5: Entry requirements 🔵
**Effort:** M · **Depends on:** F2.1, T4.2
```
✓ Import from an authoritative dataset; scheduled refresh; never LLM-generated
✓ Optional passport_country field
✓ Shown with source link, checked_at and "verify before travel"; unknown → official-sources link
```

## R1.7: Trip Q&A

### F3.1: Read-only agent tools 🔵
**Effort:** M · **Depends on:** F2.3, F2.5
```
✓ get_destination_profile, get_entry_requirement, search_activities (cache-first),
  get_session_packages — strict Zod schemas, read-only
✓ Unit tests per tool
```

### F3.2: Bounded agent + /ask 🔵
**Effort:** M · **Depends on:** F3.1, T0.6
```
✓ SDK tool runner; claude-haiku-5-5; effort low; ≤ 4 tool steps
✓ POST /v1/sessions/:id/ask {question ≤ 300}; ≤ 5 per session; spend-capped
✓ Returns AgentAnswer with citations; may include proposed_delta
✓ Out-of-scope → fixed reply; step cap → partial answer + notice
```

### F3.3: Q&A eval 🔵
**Effort:** M · **Depends on:** F3.2
```
✓ ~40 questions incl. out-of-scope and injection attempts
✓ Answer accuracy ≥ 90%; citation validity; step count; zero state writes
✓ Added to CI
```

### F3.4: Q&A UI + confirm-delta flow 🔵
**Effort:** M · **Depends on:** F3.2, T4.4
```
✓ Question box on PackagesView; answers with citations
✓ proposed_delta shown as a confirm button that calls /refine
```

## R2.0: Price Watch (optional)

### F4.1: Watch store + endpoints 🔵
**Effort:** M · **Depends on:** F2.1, T3.4
```
✓ POST /v1/watches (at select time), DELETE /v1/watches/:id, GET /v1/watches/updates
✓ Stores option IDs, baseline total, threshold, install ID; expires at departure
✓ Opt-in only
```

### F4.2: Re-pricing worker 🔵
**Effort:** M · **Depends on:** F4.1
```
✓ BullMQ repeatable job every 12–24 h; cache-first; own provider rate budget
✓ Records drops ≥ threshold as updates; provider failure skips the cycle
```

### F4.3: Extension notifications 🔵
**Effort:** S · **Depends on:** F4.1, T4.5
```
✓ chrome.alarms polls /v1/watches/updates; notification on drop
✓ Watch toggle per saved trip; stop anytime
```

---

## Critical Path

```
🟢 MVP
T0.1 → T0.2 → T0.3 → T1.1 → T1.2 → T1.5 ─┐
                 └→ T0.4 → T0.6 ──────────┼→ T2.2 → T2.4 → T2.5 → T3.3 → T4.3 → T5.2 → T5.6
                           T1.6 ──────────┘
Parallel: T0.5 → T4.1 → T4.2 · T1.3 · T1.4 · T2.1 · T3.1/T3.2 · T5.1

        ══ GATE ══

🔵 FULL
R1.5: F1.1 → F1.2 → F1.3 → F1.4      ‖  F1.5 → F1.6 → F1.7
R1.6: F2.1 → F2.2 → F2.3 → F2.4      ‖  F2.5
R1.7: F3.1 → F3.2 → F3.3 → F3.4
R2.0: F4.1 → F4.2 → F4.3   (optional)
```

---

## 🟢 MVP Commit Plan

The MVP ships as 5 milestone commits. Each one is built on its own branch (with as many small commits as needed) and squash-merged into `main` as a single commit. Every milestone must leave `main` green (lint, typecheck, tests) and demonstrable.

| # | Commit message | Tasks | Effort | Demo after merge |
|---|---|---|---|---|
| 1 | `chore: foundation — monorepo, schemas, Redis, auth, LLM client` | T0.1–T0.6 | ~13 days | Install token issued; forged tokens and rate limits rejected; extension loads |
| 2 | `feat(search): provider adapters, resilience, cache, prefetch` | T1.1–T1.6 | ~15 days | `POST /v1/prefetch` warms caches; fixture mode runs without API keys |
| 3 | `feat(core): optimizer, explanations, sessions, SSE, select` | T2.1–T2.5, T3.4 | ~15 days | Full backend flow via curl: create session → stream packages + explanations → select |
| 4 | `feat(extension): trip form, packages view, chip refinement, My Trips` | T4.1–T4.3, T4.5, T3.1, T3.3, T4.4 (chips) | ~19 days | **First usable product:** plan, refine with chips, select and save trips in Chrome |
| 5 | `feat: free-text refinement, evals, observability, deploy` | T3.2, T4.4 (text box), T5.1–T5.5 | ~16 days | Free-text refine; eval suite gates CI; deployed; privacy policy live |

T5.6 (beta, 50 sessions) runs after commit 5 and is not a code commit.

### Commit 1: Foundation
**Branch:** `m0-foundation` · **Tasks:** T0.1, T0.2, T0.3, T0.4, T0.5, T0.6
```
Includes: git init + npm workspaces, packages/schema (all Zod types), Redis session/event/
cache store, install token + rate limits + spend cap, MV3 extension scaffold, Haiku 5.5
client wrapper (structured outputs, prompt caching, traceable(), concurrency limit)
Done when:
✓ CI green (lint, typecheck, tests)
✓ Schema, store and auth tests pass
✓ Prompt-cache test shows cache_read_input_tokens > 0 on a repeated call
```
The LLM client lands here because it is infrastructure; commits 3 and 5 only add prompts.

### Commit 2: Search
**Branch:** `m1-search` · **Tasks:** T1.1, T1.2, T1.3, T1.4, T1.5, T1.6
```
Includes: SearchProvider interface, resilience (timeout, retry, breaker, shared token
bucket), flights adapter with flex dates, hotels + activities adapters, search cache,
prefetch endpoint, fixture recorder
Done when:
✓ Adapter tests pass on recorded fixtures
✓ A session after prefetch makes zero provider calls for warmed categories
✓ Fixture mode works with no provider credentials
```
**Start with:** confirming hotel and activity provider access (first step of T1.3/T1.4). If access fails, re-plan here.

### Commit 3: Planning core
**Branch:** `m2-core` · **Tasks:** T2.1, T2.2, T2.3, T2.4, T2.5, T3.4
```
Includes: constraint builder, joint optimizer, budget advice, explain call + grounding
validator, orchestrator with Redis event stream + SSE resume + restart recovery,
select endpoint (session deleted after)
Done when:
✓ Optimizer tests pass (totals, dates, budget, labels, < 50 ms benchmark)
✓ Integration test: full session on fixtures + mocked LLM, no lost events
✓ Disconnect and resume via Last-Event-ID works
```
Select is included so the backend flow is complete end to end before any UI exists.

### Commit 4: Extension + chip refinement
**Branch:** `m3-extension` · **Tasks:** T4.1, T4.2, T4.3, T4.5, T3.1, T3.3, T4.4 (chips only)
```
Includes: service worker SSE client, TripForm with prefetch, PackagesView, MyTrips,
chip deltas + applyDelta, branch rerun + /refine, RefineBar (chips only)
Done when:
✓ Plan → refine with chips → select → saved trip, in Chrome
✓ Closing the popup or dropping the network loses no progress
✓ A hotel chip triggers zero flight/activity provider calls
```
Chips need no LLM, so the whole refine loop is tested without model variability.  
**Rebalancing option:** commit 4 is the largest. Moving T3.1, T3.3 and the chip half of T4.4 to commit 5 evens the sizes, at the cost of a first product that can't refine.

### Commit 5: LLM refinement + launch readiness
**Branch:** `m4-launch` · **Tasks:** T3.2, T4.4 (text box), T5.1, T5.2, T5.3, T5.4, T5.5
```
Includes: free-text delta parser + RefineBar text box, eval suite in CI, dashboards +
alerts + redaction checks, integration + k6 load tests, Docker + deployment (≥ 2
instances), privacy policy + store listing
Done when:
✓ Evals gate CI against a stored baseline
✓ Load test (100 concurrent sessions) meets p95 targets
✓ Deployed; /health green; privacy disclosure complete
```
The eval suite is here because it covers delta parsing (T3.2).

---

## Status Update Template

```markdown
### T2.2: Joint optimizer 🟢

**Status:** 🟨 In Progress (60%)
**Updated:** 2026-11-12 14:30 UTC
**Completed:** totals, hard constraints, scoring ✓
**Remaining:** labels + dedupe, benchmark test
**Blocker:** None
**Next:** label selection tests on fixtures

**Commits:** abc123d
**PR:** #18
```

---

## Success Criteria

**🟢 MVP (release 1.0):** all 32 MVP tasks complete and the MVP success metrics in `requirements.md` met.

**🔵 FULL (per release):** the release's tasks complete and its metrics in `requirements.md` met; earlier evals still green.
