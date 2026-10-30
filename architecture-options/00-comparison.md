# Travellite Architecture Options: Comparison

| | Doc | One line |
|---|---|---|
| **A** | [01-current-langgraph.md](01-current-langgraph.md) | Current spec: LangGraph pipeline, each category picked separately, LLM writes pros/cons |
| **B** | [02-mvp-packages-deltas.md](02-mvp-packages-deltas.md) | **Recommended MVP**: code optimizes whole trips into packages, LLM explains, refinements are deltas |
| **C** | [03-full-hybrid.md](03-full-hybrid.md) | Phase 1.5+: B plus LLM at the edges (free-text intent, itinerary, knowledge, Q&A agent) |

---

## The Three Flows

**Legend:** `[LLM]` model call · `[code]` deterministic · `→` sequential · `‖` parallel

### A: Current (LangGraph)
```
form → [LLM] Planner → [code] Executor ‖ flights ‖ hotels ‖ activities
     → [LLM×9, one by one] Reviewer → Approval (top 1 per category) → links
```
Categories never meet. Every trip is just "the top flight + the top hotel + the top 3 activities."

### B: MVP (Packages + Deltas)
```
typing → [code] prefetch
form → [code] constraints → [code] search ‖ (cached, ±2 days)
     → [code] joint optimizer → 2–3 packages → [LLM×1] explain → pick
                  ▲                                               │
                  └──── refine: chip [code] / text [LLM] → delta ─┘
```
Whole trips are scored against the total budget. A refinement reruns one branch only.

### C: Full (LLM around a deterministic core)
```
offline: [LLM batch] destination profiles → human review → DB
typing → [code] prefetch
form + text → [LLM] intent→constraints → ┌ B's core: search → optimizer → packages ┐
            → [code] schedule → [LLM] narrate itinerary → pick → (opt) price watch
                  ▲                                              │
                  └────────── refine (delta) ────────────────────┘
side channel: question → [LLM agent, ≤4 steps, read-only] → answer / proposed delta
```
Code still decides everything numeric; the LLM translates in (intent) and out (narrative).

---

## At a Glance

| | **A: Current** | **B: MVP** | **C: Full** |
|---|---|---|---|
| Orchestration | LangGraph, 4 nodes | Plain TS | Plain TS + bounded agent |
| Who ranks options | Nobody (code forces #1) | Code (joint score) | Code (+ area knowledge) |
| Budget handling | Fixed split per category | Total budget, tradeoffs across categories | Same as B + typical-price data |
| Output | 1 flight, 1 hotel, 3 activities | 2–3 complete packages | Packages + day-by-day itinerary |
| Dates | Fixed | ±2 days | ±2 days |
| Refinement | Back to the form | Chips + free text → delta, 1 branch rerun | Same + "ask a question" |
| LLM calls / session | 10 | 1 + 1 per refinement | ~3–5 + agent |
| LLM cost / session* | ~$0.032 (Sonnet 5.5) · ~$0.0016 (Haiku 5.5) | ~$0.0015 | ~$0.005–0.008 |
| Results visible | ~12–24s | ~0.5–3s | ~1–3.5s |
| Session complete | ~12–24s | ~3–6s | ~5–10s (streamed) |
| Server state | Process memory | Redis, deleted after selection | Redis + Postgres (knowledge, watches) |
| LLM output users see | Pros/cons per option | Package tradeoffs | Tradeoffs + itinerary + answers |
| Main quality risk | Shallow, uncoordinated picks | Optimizer weights | LLM errors in itinerary/intent |
| How it's tested | Mostly manual | Fixtures + small eval | Fixtures + 4 eval suites |
| New data needed | — | Hotel location | Activity coordinates + hours, entry rules |
| Build time (1 dev)* | ~14 weeks (spec's own estimate) | ~16 weeks (~8-week critical path) | B + ~8 weeks |

\* Estimates. Costs exclude thinking tokens; latency assumes a warm cache where prefetch applies.

---

## Choosing

| Choose | When |
|---|---|
| **A** | Don't. Its pipeline survives as B's search step. |
| **B** | Now: validates "planner beats aggregator" with mostly testable code. |
| **C** | After B shows usage, evals exist, and activity data (coordinates, hours) is confirmed. |

**Path:** A's fixes → B → add C's parts one at a time (itinerary → intent → knowledge → agent → price watch). Each step reuses B's constraints, packages and deltas, so nothing gets rewritten.
