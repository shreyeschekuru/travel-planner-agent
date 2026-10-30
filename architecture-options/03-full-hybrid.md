# Architecture C: Full Architecture (LLM Around a Deterministic Core)

**Status:** Target for Phase 1.5+, built on Architecture B  
**Orchestration:** Plain TypeScript orchestrator for the main flow; a bounded tool-using agent (Anthropic SDK tool runner) for off-script questions. LangGraph optional (see §11).  
**Prerequisites:** Architecture B in production, eval set in CI, activity data with coordinates and opening hours confirmed.

---

## 1. Overview

Architecture C keeps B's deterministic core (search → joint optimizer → packages → deltas) and adds LLM work at the edges, where it adds the most value:

| Edge | Added | LLM role |
|---|---|---|
| **Input** | Free-text trip description | Translate intent → `Constraints` |
| **Output** | Day-by-day itinerary | Narrate a schedule that code has already built |
| **Knowledge** | Offline destination profiles | Generated in batch, reviewed, served as structured data |
| **Side channel** | Off-script Q&A ("dog-friendly?", "visa?") | Bounded agent with read-only tools |
| **After selection** | Price watching (optional) | None, scheduled job |

**Rule:** the LLM never decides prices, totals, dates, opening hours or feasibility. Code decides; the LLM translates and explains.

---

## 2. Architecture Diagram

```
                      ┌──────────────── OFFLINE ────────────────┐
                      │ Knowledge pipeline (Batch API, monthly) │
                      │  areas · "stay for X" · typical prices  │
                      │  → human review → Postgres (versioned)  │
                      │ Entry rules table (authoritative source)│
                      └───────────────────┬─────────────────────┘
                                          │ read
┌─────────────────────────────────────────┼────────────────────────────────┐
│ ONLINE                                  ▼                                │
│                                                                          │
│ form + "describe your trip" ─┬─▶ prefetch (hard fields, no LLM)          │
│                              ▼                                           │
│                    ┌──────────────────┐                                  │
│                    │ 1. Intent →      │ LLM (Haiku) + knowledge          │
│                    │    Constraints   │                                  │
│                    └────────┬─────────┘                                  │
│                             ▼                                            │
│   ┌───────────────── DETERMINISTIC CORE (= Architecture B) ───────────┐  │
│   │ 2. Search (parallel, cached, flex dates) → 3. Joint optimizer     │  │
│   │                                            → 2–3 packages         │  │
│   └─────────────────────────┬─────────────────────────────────────────┘  │
│                             ▼                                            │
│                    ┌──────────────────┐                                  │
│                    │ 4. Itinerary     │ code: cluster, schedule, hours   │
│                    │    builder       │ LLM: narrate + tradeoffs         │
│                    └────────┬─────────┘                                  │
│                             ▼                                            │
│                    5. Select package ──▶ itinerary to extension          │
│                             │                    └─▶ (opt) price watch   │
│                             ▼                                            │
│                    6. Refine: text/chip → delta → rerun branch → 3, 4    │
│                                                                          │
│   ┌── Off-script agent (side channel) ───────────────────────────────┐   │
│   │ Haiku · ≤4 steps · read-only tools · may PROPOSE a delta         │   │
│   └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Pipeline

```
[prefetch]  hard fields entered → warm caches (unchanged from B)
submit
1. extractIntent(form, free_text, knowledge)   LLM   ~1s     runs alongside prefetch
     → Constraints + InterpretedIntent (shown to the user, editable)
2. search(constraints)                         code  (B)
3. optimize(results, constraints, knowledge)   code  (B + area scoring from knowledge)
     → packages emitted immediately
4. buildSchedule(package)                      code  <100ms per package
   narrate(schedules, packages)                LLM   1 call, streamed
5. awaiting_selection
     ├─ refine(text | chip) → delta → rerun branch → 3 → 4
     ├─ ask(question) → off-script agent → answer (+ optional proposed delta)
     └─ select(package_id) → itinerary → client; optional price watch
```

---

## 4. Schemas (additions to Architecture B)

```ts
// ---- Input ----
interface TripRequest extends VacationConfig {
  description?: string;                 // ≤ 500 chars, free text
}

// ---- Intent extraction output (structured outputs) ----
interface InterpretedIntent {
  constraints_patch: ConstraintDelta;   // applied on top of form-derived constraints
  pace: "slow" | "moderate" | "packed";
  avoid: AvoidTag[];                    // enum, e.g. "crowds", "early_starts"
  must_include?: string[];              // free text, matched against activity titles
  summary: string;                      // shown to the user: "Relaxed food trip near the beach"
  confidence: "high" | "low";           // low → ask the user to confirm the summary
}

// ---- Offline destination knowledge (Postgres) ----
interface DestinationProfile {
  city_id: CityId;
  version: string;                      // e.g. "2026-10"
  reviewed_by: string;                  // human review is required before publishing
  areas: {
    id: AreaId;
    name: string;
    centroid: { lat: number; lng: number };
    tags: Preference[];                 // "beach", "nightlife", ...
    good_for: string[];                 // "first-time visitors", "families"
    typical_hotel_per_night_usd: { p25: number; p50: number; p75: number };
  }[];
  seasonal_notes: { month: number; note: string }[];
}

interface EntryRequirement {           // NOT LLM-generated
  destination_country: CountryCode;
  passport_country: CountryCode;
  requirement: "none" | "evisa" | "visa_on_arrival" | "visa_required";
  source_url: HttpsUrl;
  checked_at: ISODate;
}

// ---- Itinerary ----
interface ActivityAttrs {               // B's ActivityAttrs plus hours
  tags: Preference[];
  duration_min: number;
  opening_hours?: { day: 0|1|2|3|4|5|6; open: HHMM; close: HHMM }[];
}

interface DaySchedule {
  date: ISODate;
  area_id?: AreaId;                     // main cluster that day
  slots: {
    start: HHMM;
    end: HHMM;
    kind: "arrival" | "activity" | "free" | "meal" | "departure";
    activity_id?: string;
    travel_min_from_prev?: number;      // haversine × factor, or a maps API
  }[];
}

interface Itinerary {
  package_id: string;
  days: DaySchedule[];
  feasibility: { ok: boolean; issues: string[] };   // from code, not the LLM
}

interface ItineraryNarrative {         // LLM output
  package_id: string;
  days: { date: ISODate; title: string;
          notes: Claim[] }[];          // every claim cites activity_id / fields
  tradeoff_summary: Claim[];
}

// ---- Off-script agent ----
interface AgentAnswer {
  answer: string;
  citations: { tool: string; ref: string }[];
  proposed_delta?: ConstraintDelta;     // never applied without user confirmation
}

// ---- Price watch (optional) ----
interface PriceWatch {
  id: string;
  install_id: string;
  option_ids: string[];
  baseline_total_usd: number;
  threshold_pct: number;                // notify if total drops by ≥ this
  expires_at: ISODateTime;              // ≤ departure date
}
```

---

## 5. Component Details

### 5.1 Intent extraction
- One Haiku call with a structured output; `constraints_patch` paths limited to an enum.
- Inputs: form fields, `description`, and the destination's area list (names + tags) so the model can map "near the beach" to an `AreaId`.
- Output shown to the user as an editable summary chip before or alongside results. Low confidence means the user is asked to confirm.
- Prefetch runs in parallel on the hard fields, so this call adds little wall time.

### 5.2 Optimizer extension
- `hotel_location` uses area centroids and tags from `DestinationProfile` when activity coordinates are sparse.
- `pace` sets `max_per_day`; `avoid` filters activities by tag.

### 5.3 Itinerary builder (code)
1. Cluster activities by location (greedy by distance, at most one main area per day).
2. Assign clusters to days; day 1 and the last day are shortened around arrival and departure times.
3. Order within a day by opening hours and distance; insert travel time and meal/free slots according to `pace`.
4. Run feasibility checks: opening hours respected, no overlapping slots, travel time ≤ a threshold. Results go into `feasibility.issues`.

### 5.4 Narration (LLM)
- One call per session covering all packages, streamed. It receives the schedules and the option fields only.
- Grounding: every `Claim` cites `activity_id`s or fields; a validator drops anything that doesn't match, and any number in the text must equal the input.
- If narration fails, the schedule is still shown as a plain timeline.

### 5.5 Knowledge pipeline (offline)
- Batch API (50% cheaper) generates draft `DestinationProfile`s for the top N destinations from provider data and curated sources.
- **Human review before publish.** Versioned; refreshed monthly; unknown destinations fall back to "no profile" (optimizer uses distance only).
- `EntryRequirement` comes from an authoritative dataset, is never generated by an LLM, and is always shown with its source link and a "verify before travel" note.

### 5.6 Off-script agent
- Haiku via the SDK tool runner; ≤4 tool steps; `effort: "low"`; strict tool schemas.
- Read-only tools: `get_destination_profile`, `get_entry_requirement`, `search_activities`, `get_session_packages`.
- It cannot write session state. At most it returns `proposed_delta`, which the user confirms in the UI and which then goes through the normal refine path.
- Out-of-scope questions get a fixed reply.

### 5.7 Price watch (optional, Phase 2)
- Opt-in per itinerary. A scheduled job re-prices watched options every 12–24h, using cached provider calls and its own rate-limit budget.
- Notifies via the extension (`chrome.alarms` polling or push). Requires an install token and consent; stores option IDs and totals only.

---

## 6. API & Events (additions to B)

| Endpoint | Body | Returns |
|---|---|---|
| `POST /v1/sessions` | `TripRequest` | as B, plus `intent` event |
| `POST /v1/sessions/:id/ask` | `{question}` (≤300 chars) | `AgentAnswer` |
| `POST /v1/sessions/:id/intent` | `{summary_edits}` | `202`, re-runs from step 1 |
| `POST /v1/watches` | `{session_id, package_id, threshold_pct}` | `PriceWatch` |
| `DELETE /v1/watches/:id` | | `204` |

New events: `intent`, `schedule` (per package), `narrative` (per day, streamed), `agent_answer`.

---

## 7. LLM Calls & Cost

All online calls use Claude Haiku 5.5, `effort: "low"`, structured outputs. Estimates exclude thinking tokens.

| Call | Count / session | Approx tokens (in / out) |
|---|---|---|
| Intent extraction | 1 | 800 / 250 |
| Narrate itinerary + tradeoffs | 1 + 1 per refinement | 2,500 / 1,500 |
| Free-text delta | 0–2 | 400 / 100 |
| Off-script agent | 0–1 questions × ≤4 steps | ~1,500 / 300 per step |

Typical session (2 refinements, 1 question): **~$0.005–0.008**. The offline knowledge pipeline is a separate, fixed monthly cost per destination at batch pricing.

---

## 8. Latency (estimated)

| Stage | Time |
|---|---|
| Intent extraction (parallel with prefetch) | ~1s, mostly hidden |
| Packages visible | ~1–3.5s |
| Schedule (code) | <100ms per package |
| Narrative first day / complete | ~1s / 5–10s (streamed) |
| Refinement | 0.3–2.5s + re-narrate 3–6s |
| Off-script answer | 2–6s |

---

## 9. Failure Handling (additions to B)

| Failure | Behavior |
|---|---|
| Intent extraction fails or low confidence | Use form-only constraints; ask the user to confirm the summary |
| No `DestinationProfile` | Optimizer uses raw distances; no area labels |
| Missing opening hours | Activity scheduled with a "check hours" flag |
| Feasibility check fails | Show the issue; offer a chip ("fewer activities", "change dates") |
| Narration fails or claims are dropped | Show the plain timeline |
| Agent exceeds step cap | Returns what it has, plus "couldn't answer fully" |

---

## 10. Security (additions to B)

- Free-text `description` and `question` are length-capped, wrapped as data in prompts, and can only produce schema-limited outputs (enum delta paths, enum tags).
- The agent's tools are read-only; any state change goes through user confirmation and the normal validated refine path.
- Knowledge content is reviewed before publishing; entry requirements are never LLM-generated.
- Price watch requires opt-in, stores minimal data and expires by the departure date.
- Privacy statement updated for free-text input and watches; free text is redacted from traces.

---

## 11. Orchestration Choice

Plain TypeScript still works for the main flow: refinement re-runs a branch on state saved in Redis. Consider LangGraph when:
- Steps run **after** selection (multi-leg trips, booking follow-ups).
- The agent side channel grows into a multi-turn assistant that shares state with the main flow.
- Runs become long enough that resuming from a checkpoint is cheaper than rerunning.

---

## 12. Observability & Evaluation (additions to B)

New eval suites, run in CI alongside B's:

| Suite | Measures |
|---|---|
| Intent extraction | ~50 labeled descriptions → constraint accuracy, false-avoid rate |
| Schedule feasibility | Fixtures → opening hours, overlaps, travel time (deterministic) |
| Narrative groundedness | LLM judge with a rubric; claims traceable to inputs |
| Agent | Answer accuracy, citation validity, step count, refusal of out-of-scope questions |
| Knowledge | Spot-check reviewed profiles per refresh |

Metrics added: intent-confirmation edits, narrative claim drop rate, agent questions per session, watch notifications sent and acted on.

---

## 13. Build Order (single developer, rough, after B ships)

| Stage | Work (total ~8 dev-weeks solo) |
|---|---|
| 1–2 | Activity data (coordinates, hours), schedule builder + feasibility tests |
| 3 | Narration + grounding validator + eval |
| 4 | Intent extraction + labeled eval set + summary UI |
| 5–6 | Knowledge pipeline (batch + review tool), entry requirements table |
| 7 | Off-script agent + eval |
| later | Price watch (Phase 2) |
