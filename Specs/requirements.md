# Travellite Requirements

**Project:** Travel Planning Assistant (Browser Extension)  
**Format:** AI-Agent Optimized  
**Version:** 2.0 (replaces the LangGraph spec, archived in `_archive-v1-langgraph/`)  
**Last Updated:** 2026-10-29  
**Architecture records:** `../architecture-options/` (02 = MVP, 03 = Full)

---

## Scope Legend

Every feature, requirement and task carries one tag:

| Tag | Meaning | Ships in |
|---|---|---|
| 🟢 **MVP** | Required for the first beta release | Release 1.0 |
| 🔵 **FULL** | Added after the MVP gate is passed | Releases 1.5–2.0 |

FULL features build on MVP components; none of them replaces MVP work.

---

## Product Summary

Travellite plans whole trips, not individual bookings. The user enters trip details; Travellite searches flights, hotels and activities, then **code optimizes complete combinations against the total budget** and presents 2–3 trip packages. An LLM explains the tradeoffs. The user refines with one click or a sentence, picks a package, and books manually through provider links.

**Design rule:** code decides everything numeric (prices, totals, dates, feasibility, ranking). The LLM translates (user text → constraints) and explains (results → readable text).

---

## Release Phasing

| Release | Tag | Adds |
|---|---|---|
| 1.0 | 🟢 MVP | F1–F9: input, prefetch, search, joint packages, explanations, refinement, selection, sessions, access control |
| 1.5 | 🔵 FULL | F10 day-by-day itinerary, F11 free-text trip description |
| 1.6 | 🔵 FULL | F12 destination knowledge, F13 entry requirements |
| 1.7 | 🔵 FULL | F14 trip Q&A assistant |
| 2.0 | 🔵 FULL | F15 price watch (optional) |

**MVP → FULL gate** (all must hold before FULL work starts):
```
✓ MVP success metrics met (see bottom of this file)
✓ Eval suite running in CI
✓ Activity data with coordinates + opening hours confirmed for top destinations
✓ Provider partner access confirmed (Booking.com, TripAdvisor or alternatives)
```

---

# 🟢 MVP FEATURES

### F1: Trip Input 🟢 MVP

**User Story:** As a traveler, I want to enter my trip details quickly so Travellite can plan a trip that fits.

**Acceptance Criteria:**
```
✓ Fields: origin, destination, departure_date, return_date, date_flex_days,
  budget_usd (total trip), travelers, preferences[]
✓ Origin and destination use autocomplete against a known airport/city list
✓ return_date > departure_date; departure_date ≥ today; ≤ 365 days ahead
✓ budget_usd: 100–100,000; travelers: 1–9
✓ date_flex_days: 0, 1 or 2 (default 0)
✓ preferences: multi-select from a fixed enum (no free text in MVP)
✓ Submit disabled until all required fields are valid
✓ Draft saved to extension storage on change; restored on reopen
✓ Server re-validates every field (client validation is UX only)
```

**Data Model:**
```typescript
interface VacationConfig {
  origin: IATA;
  destination: CityId;
  departure_date: ISODate;
  return_date: ISODate;
  date_flex_days: 0 | 1 | 2;
  budget_usd: number;
  travelers: number;
  preferences: Preference[];
}
type Preference = "beach" | "museums" | "food" | "nightlife" | "outdoors"
                | "shopping" | "family" | "relaxed_pace";
```

---

### F2: Speculative Prefetch 🟢 MVP

**User Story:** As a traveler, I want results to appear almost immediately after I press Search.

**Acceptance Criteria:**
```
✓ When origin, destination and dates are valid, the extension calls POST /v1/prefetch
✓ Prefetch warms flight and hotel caches only; it never calls the LLM
✓ Prefetch is debounced (≥ 800 ms after the last field change)
✓ Prefetch is rate-limited per install token (separately from sessions)
✓ A submitted session uses prefetched results if they are within cache TTL
```

---

### F3: Provider Search 🟢 MVP

**User Story:** As a traveler, I want real prices and availability from real providers.

**Acceptance Criteria:**
```
✓ Flights, hotels and activities searched in parallel
✓ Flights searched across a date grid of ±date_flex_days; best 2–3 date pairs kept
✓ Hotels searched for each kept date pair
✓ Each provider call: 2.5 s timeout, ≤ 1 retry (429/5xx only, honoring retry-after)
✓ Per-provider circuit breaker; when open, serve cache or mark category degraded
✓ Every response validated against a schema; malformed items dropped and counted
✓ Results normalized to Option with explicit price_basis and currency
✓ Results cached: flights 15 min, hotels 1 h, activities 24 h
✓ If a category fails, the session continues with a "degraded" notice
✓ No made-up fallback data is ever shown
✓ Booking URLs must be https and on an allowlisted provider domain
```

**Data Model:**
```typescript
interface Option {
  id: string;                            // provider-prefixed
  category: "flight" | "hotel" | "activity";
  title: string;
  price: { amount: number; currency: "USD" };
  price_basis: "total" | "per_night" | "per_person";
  rating?: number;
  location?: { lat: number; lng: number };
  url: HttpsUrl;
  attrs: FlightAttrs | HotelAttrs | ActivityAttrs;
}
```

---

### F4: Joint Trip Packages 🟢 MVP

**User Story:** As a traveler, I want complete trip options that fit my total budget, not separate lists I have to combine myself.

**Acceptance Criteria:**
```
✓ Optimizer scores flight + hotel + activity combinations against the TOTAL budget
✓ Hard constraints: total ≤ budget × (1 + tolerance), hotel dates match flight dates,
  stops ≤ max_stops, hotel rating ≥ min_rating
✓ Returns 2–3 packages labeled best_value, best_location, upgrade
✓ Packages differ from each other in flight or hotel
✓ Every package total is computed in code from price_basis × nights × travelers
✓ Each package exposes a score_breakdown (cost fit, flight convenience,
  hotel location, rating, preference match)
✓ If nothing fits: no LLM call; return budget_advice (cheapest possible total,
  which category drives cost, nearest dates that fit)
✓ Packages are sent to the extension before any LLM output
✓ Optimizer runs in < 50 ms for ≤ 10 flights × 10 hotels × 20 activities
```

---

### F5: Package Explanations 🟢 MVP

**User Story:** As a traveler, I want to understand why each package is different so I can choose quickly.

**Acceptance Criteria:**
```
✓ One LLM call explains all packages (headline, 2–3 pros, 1–3 cons each)
✓ Output is schema-constrained (structured outputs); package_id must match an input ID
✓ Every claim cites the option fields it is based on
✓ A validator drops claims whose numbers don't match the input data
✓ Explanations stream per package
✓ If the LLM call fails, packages still show with bullets generated from score_breakdown
✓ The LLM never changes the ranking or the totals
```

---

### F6: Refinement 🟢 MVP

**User Story:** As a traveler, I want to adjust a plan in one step without starting over.

**Acceptance Criteria:**
```
✓ Chips: cheaper_hotel, better_hotel, fewer_stops, shift_dates_earlier,
  shift_dates_later, more_activities (mapped to deltas in code, no LLM)
✓ Free-text box (≤ 200 chars): one LLM call turns text into a ConstraintDelta
  limited to an allowlist of constraint paths
✓ Only the affected branch is re-searched (cache first); optimizer and
  explanation re-run
✓ Chip refinement shows new packages in ≤ 2.5 s (p95)
✓ Max 10 refinements per session
✓ A delta that changes nothing returns current packages with a notice
✓ The applied delta is shown to the user ("Hotel max price lowered to $120/night")
```

---

### F7: Selection & Itinerary Links 🟢 MVP

**User Story:** As a traveler, I want my chosen trip saved with booking links so I can book on my own.

**Acceptance Criteria:**
```
✓ User selects one package (the approval step)
✓ Booking links are resolved by the server from option IDs, never from client input
✓ Itinerary saved in the extension (IndexedDB): destination, dates, selections,
  total_cost, created_at
✓ Server deletes the session after selection
✓ Links open in a new tab
✓ "My Trips" lists saved itineraries; "Plan another trip" resets the form
✓ Booking is always manual; Travellite never books or takes payment
```

**Data Model:**
```typescript
interface SavedItinerary {
  session_id: string;
  package_label: "best_value" | "best_location" | "upgrade";
  destination: CityId;
  dates: { departure: ISODate; return: ISODate };
  selections: {
    flight: { url: HttpsUrl; summary: string };
    hotel: { url: HttpsUrl; summary: string };
    activities: { url: HttpsUrl; summary: string }[];
  };
  total_usd: number;
  created_at: ISODateTime;
  status: "saved" | "booked";
}
```

---

### F8: Sessions, Streaming & Recovery 🟢 MVP

**User Story:** As a traveler, I don't want to lose progress if my connection drops or the popup closes.

**Acceptance Criteria:**
```
✓ Session state stored in Redis (TTL 24 h), never in process memory
✓ Every event appended to a per-session event stream
✓ Extension receives events over SSE from the service worker
✓ Reconnect resumes from Last-Event-ID with no lost events
✓ Popup can close and reopen mid-session; state restored from extension storage
✓ Any server instance can handle any request for any session
✓ A server restart mid-run: the session is re-run from cached search results
```

**Error Types:**
```
NETWORK_ERROR · PROVIDER_TIMEOUT · PROVIDER_RATE_LIMIT · PROVIDER_BAD_PAYLOAD
INVALID_INPUT · UNAUTHORIZED · NOT_FOUND · SESSION_EXPIRED · RATE_LIMITED · SPEND_CAP · UNKNOWN_ERROR
```
Each maps to a specific user-facing message and a retry/adjust action.

---

### F9: Access Control & Spend Protection 🟢 MVP

**User Story:** As the operator, I want the API protected from abuse that would run up provider and LLM bills.

**Acceptance Criteria:**
```
✓ A signed install token is issued on first run; required on every request
✓ Each session is bound to the install token that created it
✓ Rate limits per token and per IP (sessions, refinements, prefetch separately)
✓ A global daily LLM spend counter trips a circuit breaker at a configured cap
✓ Stream connections check the Origin header (chrome-extension://<id>)
✓ All routes validate bodies with JSON schemas; enum fields reject unknown values
✓ Provider error details are never returned to clients
```

---

# 🔵 FULL FEATURES

### F10: Day-by-Day Itinerary 🔵 FULL (1.5)

**User Story:** As a traveler, I want a realistic day-by-day plan for my trip, not just a list.

**Acceptance Criteria:**
```
✓ Code builds a schedule per package: activities clustered by area, one main area
  per day, ordered by opening hours and distance, travel time between stops
✓ Day 1 and the last day fit around flight arrival and departure times
✓ Pace (slow / moderate / packed) sets activities per day
✓ Feasibility checks: opening hours respected, no overlaps, travel time ≤ threshold;
  failures shown with a fix chip ("fewer activities", "change dates")
✓ One LLM call narrates all schedules (day titles + notes), streamed
✓ Every narrative claim cites activity IDs or fields; unmatched claims dropped
✓ If narration fails, a plain timeline is shown
✓ Missing opening hours: activity scheduled with a "check hours" flag
✓ Saved itinerary includes the schedule
```

---

### F11: Free-Text Trip Description 🔵 FULL (1.5)

**User Story:** As a traveler, I want to describe the trip I want in my own words.

**Acceptance Criteria:**
```
✓ Optional text box (≤ 500 chars) alongside the form
✓ One LLM call extracts a constraints patch, pace, avoid tags and a summary
✓ Patch paths and tags limited to enums; must_include matched against activity titles
✓ Extraction runs in parallel with prefetch
✓ The interpreted summary is shown and editable; low confidence asks the user to confirm
✓ If extraction fails, form-only constraints are used
✓ Form fields always take precedence over text when they conflict
```

---

### F12: Destination Knowledge 🔵 FULL (1.6)

**User Story:** As a traveler, I want recommendations that reflect where to stay and what each area is like.

**Acceptance Criteria:**
```
✓ Offline pipeline (Batch API) drafts destination profiles for the top N destinations:
  areas, centroids, tags, "good for", typical hotel price percentiles, seasonal notes
✓ Every profile is human-reviewed before publishing; versioned; refreshed monthly
✓ Optimizer uses area data for hotel location scoring
✓ Intent extraction uses area names/tags to map phrases like "near the beach"
✓ Destinations without a profile still work (distance-only scoring)
✓ Profiles are structured data, not a vector database / RAG
```

---

### F13: Entry Requirements 🔵 FULL (1.6)

**User Story:** As a traveler, I want to know if I need a visa before I plan.

**Acceptance Criteria:**
```
✓ Optional passport country field
✓ Requirements come from an authoritative dataset, never generated by an LLM
✓ Shown with source link, last-checked date and "verify before travel" notice
✓ Unknown combinations show "check official sources" with a link
```

---

### F14: Trip Q&A Assistant 🔵 FULL (1.7)

**User Story:** As a traveler, I want to ask questions about my trip ("Is the hotel dog-friendly?").

**Acceptance Criteria:**
```
✓ Question box on the packages view (≤ 300 chars)
✓ Bounded agent: ≤ 4 tool steps, read-only tools only:
  get_destination_profile, get_entry_requirement, search_activities, get_session_packages
✓ Answers include citations to tool results
✓ The agent may propose a ConstraintDelta; it is applied only after user confirmation
  and goes through the normal refinement path
✓ Out-of-scope questions get a fixed reply
✓ Max 5 questions per session
```

---

### F15: Price Watch 🔵 FULL (2.0, optional)

**User Story:** As a traveler, I want to know if my saved trip gets cheaper before I book.

**Acceptance Criteria:**
```
✓ Opt-in per saved itinerary, with a drop threshold (%)
✓ Scheduled job re-prices watched options every 12–24 h using cached calls and its own
  rate-limit budget
✓ Notification through the extension when the total drops ≥ threshold
✓ Stores only option IDs, baseline total, threshold, install token; expires at departure
✓ User can stop a watch at any time
```

---

## Non-Functional Requirements

### Performance

| Metric | 🟢 MVP target | 🔵 FULL target |
|---|---|---|
| Packages visible after submit (p95, warm cache) | ≤ 3 s | ≤ 3.5 s |
| Session complete (p95) | ≤ 6 s | ≤ 10 s (itinerary streamed) |
| First explanation token | ≤ 1 s after packages | same |
| Chip refinement → new packages (p95) | ≤ 2.5 s | same |
| Q&A answer (p95) | — | ≤ 6 s |
| Optimizer | < 50 ms | < 50 ms + schedule < 100 ms/package |

### Cost

| Metric | 🟢 MVP | 🔵 FULL |
|---|---|---|
| LLM calls per session (typical) | 1 + 1 per refinement | 3–5 + Q&A |
| LLM cost per session (excl. thinking) | ≤ $0.003 | ≤ $0.01 |
| Model | Claude Haiku 5.5, effort low | same (online); Batch API offline |
| Global daily spend cap | Required | Required |

### Reliability
```
🟢 Survives popup close, browser restart, network drops, server restarts
🟢 Any server instance serves any session
🟢 One failed provider never fails the session
🟢 One retry budget per session; no stacked retry layers
🔵 Itinerary and Q&A failures fall back to plain output without blocking selection
```

### Security
```
🟢 Signed install token; sessions bound to token; per-token/IP rate limits; spend cap
🟢 JSON-schema validation on every route; enum-only categorical fields
🟢 Booking URLs resolved server-side; https + provider-domain allowlist
🟢 Extension renders via React only; no innerHTML / dangerouslySetInnerHTML
🟢 Manifest permissions: storage + API host only
🟢 Secrets in a secret manager; egress restricted to provider + Anthropic hosts
🟢 Provider and user text treated as data in prompts; LLM output schema-constrained
🟢 No payment data handled or stored
🔵 Q&A agent tools are read-only; state changes require user confirmation
🔵 Entry requirements never LLM-generated
```

### Privacy
```
🟢 Server holds session data ≤ 24 h and deletes it after selection
🟢 Saved itineraries live only in the extension
🟢 Traces redacted (no dates + destination + token combinations); retention set
🟢 Privacy policy matches actual data handling (Chrome Web Store disclosure)
🔵 Free-text input redacted from traces
🔵 Price watch stores minimal data and expires at departure
```

### Observability & Evaluation
```
🟢 One trace per session; spans per stage with tokens, cost, cache hits, degraded flags
🟢 Metrics: p95 per stage, cost/session, cache hit rate, provider errors,
   refinements/session, package selection rate by label
🟢 Recorded provider fixtures for deterministic tests
🟢 Eval suite in CI: optimizer correctness, explanation schema + groundedness,
   delta parsing
🔵 Eval suites for intent extraction, schedule feasibility, narrative groundedness,
   Q&A accuracy
```

---

## Out of Scope (all releases in this spec)

- ❌ Auto-booking or payment
- ❌ Multi-leg / multi-city trips
- ❌ Car rentals, trains
- ❌ Travel insurance quotes
- ❌ Collaborative planning
- ❌ User accounts (install token only)
- ❌ Vacation planner website

---

## Success Metrics

**🟢 MVP gate (50 beta sessions, 5–10 users):**
- p95 packages visible ≤ 3 s; session complete ≤ 6 s
- LLM cost per session ≤ $0.003
- Package selection rate ≥ 60% of sessions
- ≥ 1 refinement used in ≥ 40% of sessions
- Explanation groundedness ≥ 95% (eval)
- Zero unhandled crashes

**🔵 FULL (per release):**
- 1.5: itinerary feasibility ≥ 98% (eval); intent extraction accuracy ≥ 90% (eval)
- 1.6: area-aware packages selected more often than distance-only (A/B)
- 1.7: Q&A answer accuracy ≥ 90% (eval); zero unconfirmed state changes
- 2.0: watch notifications acted on ≥ 20%
