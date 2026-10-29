# Travellite Requirements

**Project:** Travel Planning AI Agent (Browser Extension)  
**Format:** AI-Agent Optimized  
**Status:** Ready for Implementation  

---

## Feature Specifications

### F1: Vacation Configuration Input

**User Story:**
As a traveler, I want to input my trip details so the agent can generate a personalized plan.

**Acceptance Criteria:**
```
✓ Form displays in extension popup
✓ Fields: destination, departure_date, return_date, budget_usd, travelers, preferences[]
✓ Destination autocomplete (validates against known cities)
✓ Date validation: return_date > departure_date
✓ Budget validation: 100 ≤ budget ≤ 100,000 USD
✓ Submit button disabled until all required fields valid
✓ Form data persists to IndexedDB on change
✓ Restored on extension reopen
```

**Data Model:**
```typescript
interface VacationConfig {
  destination: string;
  departure_date: ISO8601;
  return_date: ISO8601;
  budget_usd: number;
  travelers: number;
  preferences: string[]; // ["beach", "museums", "nightlife", ...]
}
```

---

### F2: Plan Generation

**User Story:**
As a traveler, I want the agent to decompose my trip into tasks so I understand what needs booking.

**Acceptance Criteria:**
```
✓ Planner node generates task list within 2s
✓ Output: tasks[], budget_allocation {flights: %, accommodations: %, activities: %}
✓ Budget allocation sums to 100%
✓ Allocation adapts to trip length (short: less accommodations, long: multiple nights)
✓ Identifies visa/insurance needs based on destination
✓ Extension shows progress ("Generating plan...")
✓ Caches destination plans for 24h (Redis)
✓ Cache hit skips Claude call
```

**Data Model:**
```typescript
interface Plan {
  tasks: Task[];
  budget_allocation: {
    flights: number;
    accommodations: number;
    activities: number;
  };
  generated_at: ISO8601;
}
```

---

### F3: API Data Fetching

**User Story:**
As a traveler, I want real market data so I see actual prices and availability.

**Acceptance Criteria:**
```
✓ Fetches in parallel: flights (Amadeus), hotels (Booking), activities (TripAdvisor)
✓ Completes all 3 within 3s
✓ Returns top 10-20 results per API
✓ Results normalized: Option {id, title, price, rating, url, ...}
✓ Deduplicates by ID
✓ Fallback if one API fails (continue with other 2)
✓ Rate limit handling: retry with exponential backoff
✓ Timeout fallback: return cached options or error
```

**Data Model:**
```typescript
interface Option {
  id: string;
  category: "flights" | "accommodations" | "activities";
  title: string;
  price: number;
  rating: number;
  url: string;
  pros?: string[];
  cons?: string[];
  recommended?: boolean;
}
```

---

### F4: Results Analysis

**User Story:**
As a traveler, I want to understand pros/cons for each option so I can make informed decisions.

**Acceptance Criteria:**
```
✓ Analyzes top 3 options per category
✓ Generates 2-3 pros and 2-3 cons per option
✓ Marks first (best) option as "recommended: true"
✓ Pros/cons are data-driven (not generic)
✓ Analysis streams in real-time (first option < 1s)
✓ Rationale explains why each option is recommended or not
✓ Respects user preferences in recommendations
✓ Flags options > 90% of budget allocation
```

**Data Model:**
```typescript
interface OptionAnalysis {
  option_id: string;
  pros: string[];
  cons: string[];
  recommended: boolean;
  rationale: string;
}
```

---

### F5: Approval Checkpoint (All Bookings)

**User Story:**
As a traveler, I want to review and approve before booking links appear so I maintain control.

**Acceptance Criteria:**
```
✓ Approval modal shows after analysis completes
✓ Displays: flight summary, hotel summary, activity list
✓ Shows total estimated cost
✓ Each category has approve/reject toggle
✓ "Approve All" button if all approved
✓ "Adjust Search" button returns to form
✓ Approval state saved to IndexedDB
✓ No booking links shown without approval
✓ User can approve/reject individually
✓ Approved selections persisted
```

**Data Model:**
```typescript
interface ApprovalState {
  pending_bookings: {
    flight?: Option;
    accommodation?: Option;
    activities?: Option[];
  };
  approval_status: {
    flight: "pending" | "approved" | "rejected";
    accommodation: "pending" | "approved" | "rejected";
    activities: "pending" | "approved" | "rejected";
  };
  approved_selections: ApprovedSelections;
}
```

---

### F6: Booking Itinerary

**User Story:**
As a traveler, I want to see approved recommendations with booking links so I can book manually.

**Acceptance Criteria:**
```
✓ Itinerary displays after approval
✓ Shows: flight link, hotel link, activity links
✓ Each link opens in new tab (doesn't close extension)
✓ Links are valid URLs (tested, no 404)
✓ Itinerary persists in IndexedDB
✓ "View My Trips" shows list of saved itineraries
✓ Trip metadata saved: destination, dates, total_cost, created_at
✓ "Plan Another Trip" button resets form
```

**Data Model:**
```typescript
interface ApprovedItinerary {
  session_id: string;
  destination: string;
  dates: { departure: ISO8601; return: ISO8601 };
  selections: {
    flight: { url: string; summary: string };
    accommodation: { url: string; summary: string };
    activities: { url: string; summary: string }[];
  };
  total_cost: number;
  created_at: ISO8601;
  status: "approved" | "booked";
}
```

---

### F7: Error Handling & Recovery

**User Story:**
As a user, I want clear errors and recovery options so I can resolve issues without data loss.

**Acceptance Criteria:**
```
✓ Network errors: show "Connection lost. Retrying..." with progress
✓ API errors: specific message ("Flights unavailable for this date. Try different dates?")
✓ Automatic retry with exponential backoff (1s, 2s, 4s, 8s, 16s max)
✓ After 3 failed retries: show "Contact support" link
✓ Session state saved before risky operations
✓ Can resume from checkpoint if crash
✓ Extension crash: reopen and resume from saved state
✓ All errors logged to LangSmith for debugging
```

**Error Types:**
```
- NETWORK_ERROR: Connection lost
- API_TIMEOUT: API took > 10s
- API_RATE_LIMIT: 429 response
- INVALID_INPUT: Validation failed
- SESSION_EXPIRED: 24h+ inactive
- UNKNOWN_ERROR: Unexpected error
```

---

## Non-Functional Requirements

### Performance
| Metric | Target | Notes |
|--------|--------|-------|
| Time to first token | <2s | Streaming perceivable |
| Full plan generation | <8s | User doesn't perceive as stuck |
| API fetch (parallel) | <3s | Network optimization |
| Approval modal appear | <0.5s | Smooth UX after analysis |

### Cost
| Metric | Target |
|--------|--------|
| Tokens per session | <4,000 (with cache: ~2,000) |
| Cost per session | <$0.025 |
| Cache hit rate | >50% |

### Reliability
```
✓ Extension survives browser restart
✓ Session persists after crash
✓ WebSocket reconnects automatically
✓ API fallbacks prevent cascading failures
✓ No data loss on network interruption
```

### Security
```
✓ No payment data stored
✓ Vacation data in browser only (IndexedDB)
✓ WebSocket over TLS (WSS://)
✓ Session expires after 24h inactivity
✓ CORS headers restrict API access
```

---

## Out of Scope (MVP)

- ❌ Vacation planner webpage (Phase 2)
- ❌ Multi-leg trips (Phase 2)
- ❌ Car rentals, trains (Phase 2)
- ❌ Travel insurance quotes (Phase 2)
- ❌ Visa application assistance (Phase 2)
- ❌ Auto-booking / payment integration (MVP = manual only)
- ❌ Price tracking / rebooking alerts (Phase 2)
- ❌ Collaborative planning (Phase 2)

---

## Success Metrics

**MVP Launch (50 test sessions):**
- ✓ Average session < 8s
- ✓ Average tokens < 4,000
- ✓ Cache hit rate > 50%
- ✓ User approval rate > 80%
- ✓ Zero crashes

**Production (100 DAU):**
- ✓ 95% uptime
- ✓ p95 latency < 10s
- ✓ Cost per session < $0.02

---

## Testing Strategy

### Unit Tests
- Vacation config validation
- Plan generation logic
- API response parsing
- Analysis generation

### Integration Tests
- Full flow: input → plan → fetch → analyze → approve → itinerary
- API fallback scenarios
- WebSocket streaming
- IndexedDB persistence

### E2E Tests
- 50 manual sessions across different destinations
- Network interruption scenarios
- Extension crash recovery
- Booking link validity

