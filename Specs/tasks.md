# Travellite Tasks

**Project:** Travel Planning AI Agent (Browser Extension)  
**Format:** AI-Agent Optimized with Status Tracking  
**Status:** Ready for Implementation  
**Last Updated:** 2026-09-21  

---

## Task Status Dashboard

```
PHASE 1 (Week 1): Foundation
├─ T1.1 [  ] Project Setup & Dependencies
├─ T1.2 [  ] Claude API Integration
├─ T1.3 [  ] LangGraph State Machine
├─ T1.4 [  ] Chrome Extension Manifest
├─ T1.5 [  ] IndexedDB Schema
└─ PHASE 1 STATUS: 0/5 complete

PHASE 2 (Week 2-3): Core Features
├─ T2.1 [  ] Planner Node
├─ T2.2 [  ] Executor Node
├─ T2.3 [  ] Amadeus API Client
├─ T2.4 [  ] Booking.com API Client
├─ T2.5 [  ] TripAdvisor API Client
├─ T2.6 [  ] Reviewer Node
├─ T2.7 [  ] Input Form Component
├─ T2.8 [  ] Streaming Progress Component
├─ T2.9 [  ] Approval Modal Component
└─ PHASE 2 STATUS: 0/9 complete

PHASE 3 (Week 4): Integration & Deployment
├─ T3.1 [  ] POST /plan Endpoint
├─ T3.2 [  ] WebSocket Streaming Endpoint
├─ T3.3 [  ] POST /approve Endpoint
├─ T3.4 [  ] WebSocket Client (Extension)
├─ T3.5 [  ] Itinerary Component
├─ T3.6 [  ] E2E Testing (Manual)
├─ T3.7 [  ] Unit Tests
├─ T3.8 [  ] Docker & Deployment
└─ PHASE 3 STATUS: 0/8 complete

OVERALL: 0/22 tasks (0%)
```

---

## PHASE 1: Foundation (Week 1)

### T1.1: Project Setup & Dependencies

**Status:** ⬜ Not Started  
**Effort:** S (1-2 days)  
**Dependencies:** None  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Git repo initialized (GitHub)
✓ package.json created with all dependencies
  - Fastify, @langchain/langgraph, dotenv, axios, typescript
✓ TypeScript configured (tsconfig.json)
✓ .env.example created with required keys
✓ npm run dev starts server on localhost:3000
✓ npm run build compiles TypeScript successfully
✓ npm run test runs test suite
```

**Subtasks:**
```
- [ ] Create GitHub repo
- [ ] npm init -y && install dependencies
- [ ] Create tsconfig.json
- [ ] Create .env.example
- [ ] Test: npm run dev
```

**Deliverables:**
- GitHub repo with README
- package.json with versions pinned
- TypeScript config

**Testing:**
```bash
npm run dev
# Expected output: "Server listening on port 3000"
```

---

### T1.2: Claude API Integration

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.1  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ AnthropicClient class wraps Claude API
✓ Streaming responses work: client.stream(prompt) yields tokens
✓ Token counting implemented: client.countTokens(prompt)
✓ Prompt caching supported with cache_key parameter
✓ Error handling for 429 (rate limit) with exponential backoff
✓ Streaming token updates to LangSmith
✓ Unit tests pass (5 test cases)
```

**Subtasks:**
```
- [ ] Create src/ai/claude.ts with AnthropicClient
- [ ] Implement stream() method with token counting
- [ ] Implement countTokens() method
- [ ] Implement cache_key parameter for caching
- [ ] Add exponential backoff retry logic
- [ ] Create src/ai/claude.test.ts
- [ ] All tests pass
```

**Deliverables:**
- src/ai/claude.ts (AnthropicClient)
- src/ai/claude.test.ts (5 tests)

**Testing:**
```bash
npm run test -- src/ai/claude.test.ts
# Expected: All 5 tests pass
```

---

### T1.3: LangGraph State Machine

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.1  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ TravelliteState interface defined with all fields
✓ LangGraph state graph created with 4 nodes
  - planner, executor, reviewer, approval (placeholder functions)
✓ Edges connected: planner → executor → reviewer → approval
✓ Entry point set to "planner"
✓ Graph compiles without errors
✓ Can invoke graph with vacation_config
✓ Unit test: nodes execute in order
```

**Subtasks:**
```
- [ ] Create src/types/state.ts with TravelliteState interface
- [ ] Create src/graph/graph.ts
- [ ] Define 4 node functions (placeholder implementations)
- [ ] Connect edges in sequence
- [ ] Compile graph with .compile()
- [ ] Create src/graph/graph.test.ts
- [ ] Test: graph invocation works
```

**Deliverables:**
- src/types/state.ts
- src/graph/graph.ts
- src/graph/graph.test.ts

**Testing:**
```bash
npm run test -- src/graph/graph.test.ts
# Expected: Graph instantiates and invokes correctly
```

---

### T1.4: Chrome Extension Manifest

**Status:** ⬜ Not Started  
**Effort:** S (1-2 days)  
**Dependencies:** None  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ manifest.json v3 with correct schema
✓ Permissions: activeTab, storage, scripting, identity
✓ popup.html stub (placeholder form)
✓ popup.js with basic DOM setup
✓ background.js service worker (placeholder)
✓ popup.css with basic styling
✓ Extension loads in Chrome Dev Mode without errors
✓ Popup opens without console errors
```

**Subtasks:**
```
- [ ] Create extension/ directory structure
- [ ] Create manifest.json (v3)
- [ ] Create popup.html (form stub)
- [ ] Create popup.js (DOM setup)
- [ ] Create background.js (service worker)
- [ ] Create popup.css (basic styling)
- [ ] Load unpacked in Chrome
- [ ] Verify no console errors
```

**Deliverables:**
- manifest.json
- popup.html
- popup.js
- background.js
- popup.css

**Testing:**
```
1. Open Chrome Dev Mode
2. Load unpacked extension/
3. Open popup
4. Check console for errors (should be none)
```

---

### T1.5: IndexedDB Schema

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.4  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ IndexedDB initialized on extension install
✓ Tables created:
  - sessions (keyPath: id, indexes: created_at, status)
  - itineraries (keyPath: id, indexes: destination, created_at)
  - cache (keyPath: key, indexes: ttl)
✓ CRUD operations implemented:
  - db.sessions.create(), get(), update(), delete()
  - db.cache.set(), get() with TTL
✓ Cache expiration auto-purges expired entries
✓ Error handling for quota exceeded
✓ Unit tests pass (5 test cases)
```

**Subtasks:**
```
- [ ] Create src/db/indexeddb.ts
- [ ] Initialize DB on extension install
- [ ] Create sessions table with indexes
- [ ] Create itineraries table with indexes
- [ ] Create cache table with TTL
- [ ] Implement CRUD for each table
- [ ] Add cache.set(key, value, ttl) with auto-expiration
- [ ] Create src/db/indexeddb.test.ts
- [ ] All tests pass
```

**Deliverables:**
- src/db/indexeddb.ts
- src/db/indexeddb.test.ts

**Testing:**
```bash
npm run test -- src/db/indexeddb.test.ts
# Expected: CRUD and TTL tests pass
```

---

## PHASE 2: Core Features (Week 2-3)

### T2.1: Planner Node

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.2, T1.3  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Generates task list + budget allocation in <2s
✓ Checks Redis cache before calling Claude
✓ Cache hit returns cached plan (skip Claude)
✓ Budget allocation sums to 100% and adapts to trip length
✓ Identifies visa/insurance needs by destination
✓ Validates output JSON matches Plan interface
✓ Caches result for 24h
✓ Unit tests: cache hit, cache miss, budget logic, visa detection
```

**Subtasks:**
```
- [ ] Implement planner node function in src/nodes/planner.ts
- [ ] Add cache check (Redis)
- [ ] Integrate Claude API for plan generation
- [ ] Validate JSON output
- [ ] Cache result for 24h
- [ ] Create src/nodes/planner.test.ts with 4 test cases
- [ ] All tests pass
```

**Deliverables:**
- src/nodes/planner.ts
- src/nodes/planner.test.ts

**Testing:**
```bash
npm run test -- src/nodes/planner.test.ts
# Expected: Cache hit/miss, budget logic, visa detection all pass
```

---

### T2.2: Executor Node

**Status:** ⬜ Not Started  
**Effort:** L (3-4 days)  
**Dependencies:** T1.3, T2.3, T2.4, T2.5  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Calls all 3 APIs in parallel with Promise.all()
✓ Completes all fetches within 3s
✓ Parses responses → Option[] interface (flights, hotels, activities)
✓ Returns top 20 results per API
✓ Fallback if one API fails (continue with other 2)
✓ Rate limit handling: retry with exponential backoff
✓ Timeout fallback: return cached options or empty array
✓ Unit tests: parallel execution, fallback scenarios, parsing
```

**Subtasks:**
```
- [ ] Implement executor node in src/nodes/executor.ts
- [ ] Call amadeus.searchFlights() in parallel
- [ ] Call booking.searchHotels() in parallel
- [ ] Call tripadvisor.searchActivities() in parallel
- [ ] Parse responses to Option interface
- [ ] Implement fallback logic
- [ ] Handle rate limits with retry
- [ ] Create src/nodes/executor.test.ts with 5 test cases
- [ ] All tests pass
```

**Deliverables:**
- src/nodes/executor.ts
- src/nodes/executor.test.ts

**Testing:**
```bash
npm run test -- src/nodes/executor.test.ts
# Expected: All API calls, fallbacks, and parsing work
```

---

### T2.3: Amadeus API Client

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.2  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ AmadeusClient.searchFlights() implemented
✓ Returns flights with: id, airline, price, departure, return, url, rating
✓ Top 10-20 results sorted by price + rating
✓ Error handling: invalid IATA code, no flights found, rate limit
✓ Retry logic for 429 (rate limit)
✓ Unit tests: valid search, invalid input, error handling
```

**Subtasks:**
```
- [ ] Create src/api/amadeus.ts
- [ ] Implement searchFlights() method
- [ ] Parse Amadeus response to Flight interface
- [ ] Sort by price + rating
- [ ] Add retry logic for rate limit
- [ ] Handle invalid airport codes
- [ ] Create src/api/amadeus.test.ts with 4 test cases
- [ ] All tests pass
```

**Deliverables:**
- src/api/amadeus.ts
- src/api/amadeus.test.ts

**Testing:**
```bash
npm run test -- src/api/amadeus.test.ts
# Expected: Valid search, invalid input, and error handling all pass
```

---

### T2.4: Booking.com API Client

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.2  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ BookingClient.searchHotels() implemented
✓ Returns hotels with: id, name, price_per_night, rating, url
✓ Top 10-20 results sorted by price + rating
✓ Error handling: city not found, no availability, rate limit
✓ Retry logic for 429
✓ Unit tests: valid search, invalid city, error handling
```

**Subtasks:**
```
- [ ] Create src/api/booking.ts
- [ ] Implement searchHotels() method
- [ ] Parse Booking.com response to Hotel interface
- [ ] Sort by price + rating
- [ ] Add retry logic for rate limit
- [ ] Handle invalid cities
- [ ] Create src/api/booking.test.ts with 4 test cases
- [ ] All tests pass
```

**Deliverables:**
- src/api/booking.ts
- src/api/booking.test.ts

**Testing:**
```bash
npm run test -- src/api/booking.test.ts
# Expected: Valid search, invalid input, and error handling all pass
```

---

### T2.5: TripAdvisor API Client

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.2  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ TripAdvisorClient.searchActivities() implemented
✓ Returns activities with: id, title, price, rating, url
✓ Top 20 results sorted by rating + popularity
✓ Filter by interests (museums, outdoor, nightlife, food, etc.)
✓ Error handling: location not found, no activities, rate limit
✓ Retry logic for 429
✓ Unit tests: valid search, interest filter, error handling
```

**Subtasks:**
```
- [ ] Create src/api/tripadvisor.ts
- [ ] Implement searchActivities() method
- [ ] Parse TripAdvisor response to Activity interface
- [ ] Filter by interests parameter
- [ ] Sort by rating + popularity
- [ ] Add retry logic for rate limit
- [ ] Handle invalid locations
- [ ] Create src/api/tripadvisor.test.ts with 4 test cases
- [ ] All tests pass
```

**Deliverables:**
- src/api/tripadvisor.ts
- src/api/tripadvisor.test.ts

**Testing:**
```bash
npm run test -- src/api/tripadvisor.test.ts
# Expected: Valid search, interest filter, and error handling all pass
```

---

### T2.6: Reviewer Node

**Status:** ⬜ Not Started  
**Effort:** L (3-4 days)  
**Dependencies:** T1.2, T1.3, T2.1  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Analyzes top 3 options per category (flights, hotels, activities)
✓ Generates pros/cons per option
✓ Marks first option as "recommended: true"
✓ Streams analysis to extension in real-time
✓ No waiting for all analyses (send as completed)
✓ Respects user preferences in recommendations
✓ Unit tests: analysis generation, streaming, recommendation logic
```

**Subtasks:**
```
- [ ] Implement reviewer node in src/nodes/reviewer.ts
- [ ] Extract top 3 of each category
- [ ] Generate analysis prompt for Claude
- [ ] Stream results to extension
- [ ] Mark first option as recommended
- [ ] Add timeout handling
- [ ] Create src/nodes/reviewer.test.ts with 4 test cases
- [ ] All tests pass
```

**Deliverables:**
- src/nodes/reviewer.ts
- src/nodes/reviewer.test.ts

**Testing:**
```bash
npm run test -- src/nodes/reviewer.test.ts
# Expected: Analysis generation, streaming, and recommendations work
```

---

### T2.7: Input Form Component

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.4, T1.5  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Form displays in extension popup
✓ Fields: destination, departure_date, return_date, budget, travelers, preferences
✓ Destination autocomplete suggestions
✓ Date validation: return > departure
✓ Budget validation: 100-100,000 USD
✓ Submit button disabled until all required fields valid
✓ Form data persists to IndexedDB on change
✓ Restored on extension reopen
```

**Subtasks:**
```
- [ ] Update popup.html with form fields
- [ ] Create src/components/InputForm.tsx
- [ ] Add destination autocomplete
- [ ] Add date picker with validation
- [ ] Add budget input with validation
- [ ] Add travelers spinner
- [ ] Add preferences checkboxes
- [ ] Connect to IndexedDB for persistence
- [ ] Create manual test cases (5 scenarios)
```

**Deliverables:**
- src/components/InputForm.tsx
- Updated popup.html
- Test scenarios documented

**Testing:**
```
Manual tests:
- Fill form with valid data → submit enabled
- Set invalid dates → error shown
- Close/reopen extension → form restored
```

---

### T2.8: Streaming Progress Component

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.4  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Displays current node label (Planning → Fetching → Analyzing)
✓ Shows live token count
✓ Shows elapsed time
✓ Animated progress indicator
✓ WebSocket integration (listens for node_start, token, node_end)
✓ Updates UI as messages arrive
✓ Smooth transitions between nodes
```

**Subtasks:**
```
- [ ] Create src/components/StreamingProgress.tsx
- [ ] Add node label display
- [ ] Add token counter
- [ ] Add elapsed time display
- [ ] Add animated progress bar
- [ ] Connect to WebSocket events
- [ ] Style with CSS animations
- [ ] Create manual test (observe streaming)
```

**Deliverables:**
- src/components/StreamingProgress.tsx
- CSS for animations

**Testing:**
```
Manual test:
- Connect WebSocket
- Observe progress updates in real-time
- Verify token count increments
```

---

### T2.9: Approval Modal Component

**Status:** ⬜ Not Started  
**Effort:** L (3-4 days)  
**Dependencies:** T1.4, T2.6  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Modal displays flight card (title, price, pros/cons)
✓ Modal displays hotel card (title, price/night, pros/cons)
✓ Modal displays activity list (3 activities with titles, prices)
✓ Shows total estimated cost
✓ Approve/reject toggles per category
✓ "Approve All" button
✓ "Adjust Search" button returns to form
✓ Keyboard navigable (Tab, Enter, Escape)
✓ WCAG AA color contrast
```

**Subtasks:**
```
- [ ] Create src/components/ApprovalModal.tsx
- [ ] Design flight card layout
- [ ] Design hotel card layout
- [ ] Design activity list layout
- [ ] Add approve/reject buttons
- [ ] Add "Approve All" button
- [ ] Add "Adjust Search" button
- [ ] Implement keyboard navigation
- [ ] Test accessibility
- [ ] Create manual test (render with sample data)
```

**Deliverables:**
- src/components/ApprovalModal.tsx
- CSS for modal styling

**Testing:**
```
Manual test:
- Render modal with sample data
- Click approve → state updates
- Press Escape → modal closes
```

---

## PHASE 3: Integration & Deployment (Week 4)

### T3.1: POST /plan Endpoint

**Status:** ⬜ Not Started  
**Effort:** S (1-2 days)  
**Dependencies:** T1.1, T2.1  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Endpoint: POST /plan
✓ Accepts vacation_config in request body
✓ Validates input (all required fields present)
✓ Generates session_id (UUID)
✓ Starts graph execution async (don't wait for response)
✓ Returns: {session_id, ws_url}
✓ Invalid input → 400 Bad Request
✓ Server error → 500 Internal Server Error
```

**Subtasks:**
```
- [ ] Create src/routes/plan.ts
- [ ] Implement request validation
- [ ] Generate session UUID
- [ ] Start async graph execution
- [ ] Return session_id and ws_url
- [ ] Add error handling
- [ ] Create manual test with curl
```

**Deliverables:**
- src/routes/plan.ts

**Testing:**
```bash
curl -X POST http://localhost:3000/plan \
  -H "Content-Type: application/json" \
  -d '{"vacation_config": {...}}'
# Expected: {"session_id": "...", "ws_url": "..."}
```

---

### T3.2: WebSocket Streaming Endpoint

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.1, T2.1, T2.2, T2.6  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Endpoint: WSS /stream/{sessionId}
✓ Accepts WebSocket upgrade
✓ Sends events to client:
  - type: "node_start", "token", "node_end", "awaiting_approval", "error"
✓ Binds to graph execution for session
✓ Streams tokens as they arrive (no batching)
✓ Handles connection drops gracefully
✓ Invalid sessionId → 404
```

**Subtasks:**
```
- [ ] Create src/routes/stream.ts with WebSocket handler
- [ ] Parse sessionId from URL
- [ ] Validate session exists
- [ ] Bind to session's graph execution
- [ ] Forward node_start/end events
- [ ] Forward token events
- [ ] Handle connection close
- [ ] Create manual test with wscat
```

**Deliverables:**
- src/routes/stream.ts

**Testing:**
```bash
wscat -c wss://localhost:3000/stream/abc123
# Expected: Receive node_start, then tokens, then node_end
```

---

### T3.3: POST /approve Endpoint

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.1, T2.6  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Endpoint: POST /session/{sessionId}/approve
✓ Accepts: {approved: boolean, category: "flight"|"accommodation"|"activities"|"all"}
✓ Marks category as approved/rejected
✓ Builds booking URLs for approved options
✓ Returns approved_selections
✓ Logs approval decision
✓ Session not found → 404
✓ No pending approval → 400
```

**Subtasks:**
```
- [ ] Create src/routes/approve.ts
- [ ] Parse sessionId and approval data
- [ ] Validate session exists
- [ ] Update approval status in session
- [ ] Build booking URLs
- [ ] Log approval decision
- [ ] Return approved_selections
- [ ] Add error handling
- [ ] Create manual test with curl
```

**Deliverables:**
- src/routes/approve.ts

**Testing:**
```bash
curl -X POST http://localhost:3000/session/abc123/approve \
  -H "Content-Type: application/json" \
  -d '{"approved": true, "category": "all"}'
# Expected: {"status": "approved", "approved_selections": {...}}
```

---

### T3.4: WebSocket Client (Extension)

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.4, T2.7, T2.8  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Background script connects WebSocket on form submit
✓ Receives and handles all event types
✓ Forwards events to popup (content message)
✓ Reconnection logic: exponential backoff
✓ Shows "Reconnecting..." UI on disconnect
✓ Resumes from checkpoint on reconnect
✓ Session state persists in IndexedDB
```

**Subtasks:**
```
- [ ] Update src/background.js (service worker)
- [ ] Implement WebSocket connection in background.js
- [ ] Handle node_start, token, node_end, awaiting_approval events
- [ ] Send messages to popup component
- [ ] Implement reconnection logic
- [ ] Persist session state to IndexedDB
- [ ] Create manual test (observe reconnection)
```

**Deliverables:**
- Updated src/background.js

**Testing:**
```
Manual test:
- Submit form
- Observe WebSocket connects
- Pull network cable → "Reconnecting..." shows
- Plug back in → resumes
```

---

### T3.5: Itinerary Component

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** T1.4, T3.3  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Displays approved flight with booking link
✓ Displays approved hotel with booking link
✓ Displays activity list with booking links
✓ Each link opens in new tab (doesn't close extension)
✓ Shows total estimated cost
✓ "Plan Another Trip" button resets form
✓ Saves itinerary to IndexedDB
✓ Loads from IndexedDB on extension reopen
✓ Shows "My Trips" list if multiple saved
```

**Subtasks:**
```
- [ ] Create src/components/ItineraryDisplay.tsx
- [ ] Display approved selections with links
- [ ] Implement link click handler (window.open)
- [ ] Save itinerary to IndexedDB on mount
- [ ] Load from IndexedDB on extension reopen
- [ ] Create "My Trips" list view
- [ ] Add "Plan Another Trip" button
- [ ] Create manual test (click links, verify open in new tab)
```

**Deliverables:**
- src/components/ItineraryDisplay.tsx

**Testing:**
```
Manual test:
- View itinerary
- Click booking link → opens in new tab
- Close extension, reopen → itinerary still visible
```

---

### T3.6: E2E Testing (Manual)

**Status:** ⬜ Not Started  
**Effort:** L (4-5 days)  
**Dependencies:** All Phase 1-3 tasks  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ 50 manual test sessions across different destinations
✓ Happy path: input → plan → fetch → analyze → approve → itinerary (< 8s)
✓ API fallback: one API fails → continue with others
✓ Network disconnect: pull cable → reconnect → resume
✓ Partial approval: approve flight, reject hotel
✓ Invalid input: wrong dates → validation error → fix → retry
✓ Cache hit: same destination twice → faster 2nd time
✓ Performance: all sessions < 8s
✓ Cost: all sessions < $0.025
```

**Subtasks:**
```
- [ ] Test Destination 1 (Paris): complete flow
- [ ] Test Destination 2 (NYC): complete flow
- [ ] Test Destination 3 (Tokyo): complete flow
- [ ] Test Destination 4 (Sydney): complete flow
- [ ] Test API fallback (mock Amadeus failure)
- [ ] Test network disconnect
- [ ] Test partial approval
- [ ] Test invalid input (20+ scenarios)
- [ ] Test cache hit (same destination twice)
- [ ] Document all results
```

**Deliverables:**
- Test results document (50 sessions)
- Performance metrics (latency, cost, cache hit rate)
- Bug report (if any issues found)

**Testing:**
```
Manual flow:
1. Open extension
2. Enter destination: Paris, dates: Dec 1-7, budget: $3000
3. Click "Start Planning"
4. Observe streaming progress
5. Review approval modal
6. Click "Approve All"
7. Verify itinerary displays with valid links
8. Click booking link → should open in browser
9. Verify cache hit on next search for same destination
```

---

### T3.7: Unit Tests

**Status:** ⬜ Not Started  
**Effort:** M (2-3 days)  
**Dependencies:** All core tasks  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ All unit tests pass (36+ tests across all modules)
✓ Coverage > 80% for core files
✓ npm run test command runs all tests
✓ npm run test:coverage shows coverage report
✓ No console warnings or errors
```

**Test Coverage Target:**
```
src/nodes/planner.test.ts ................... 6 tests
src/nodes/executor.test.ts ................. 8 tests
src/nodes/reviewer.test.ts ................. 6 tests
src/api/amadeus.test.ts .................... 4 tests
src/api/booking.test.ts .................... 4 tests
src/api/tripadvisor.test.ts ................ 4 tests
src/db/indexeddb.test.ts ................... 5 tests
src/ai/claude.test.ts ...................... 5 tests
────────────────────────────────────────────────
TOTAL: 42 tests expected
```

**Subtasks:**
```
- [ ] Run all unit tests
- [ ] Verify all pass
- [ ] Generate coverage report
- [ ] Identify gaps (< 80% coverage)
- [ ] Add additional tests for gaps
- [ ] Verify coverage > 80%
- [ ] Document test results
```

**Deliverables:**
- Test results report
- Coverage report (npm run test:coverage)

**Testing:**
```bash
npm run test
# Expected: Passed: 42/42 tests

npm run test:coverage
# Expected: >80% coverage for all core files
```

---

### T3.8: Docker & Deployment

**Status:** ⬜ Not Started  
**Effort:** S (1-2 days)  
**Dependencies:** T1.1  
**Assigned To:** [Awaiting Assignment]

**Acceptance Criteria:**
```
✓ Dockerfile created with Node.js 20 base
✓ docker build succeeds without errors
✓ docker run starts server on port 3000
✓ .dockerignore excludes node_modules, .git
✓ Environment variables loaded from .env
✓ Deployment to Render.com configured
✓ Auto-deploy on push to main branch
✓ All environment variables set in Render
```

**Subtasks:**
```
- [ ] Create Dockerfile
- [ ] Create .dockerignore
- [ ] Test: docker build -t travellite .
- [ ] Test: docker run -p 3000:3000 travellite
- [ ] Verify: curl localhost:3000/health → 200
- [ ] Create Render.com project
- [ ] Connect GitHub repo
- [ ] Set environment variables in Render
- [ ] Test: deploy on push to main
```

**Deliverables:**
- Dockerfile
- .dockerignore
- Render deployment configured

**Testing:**
```bash
docker build -t travellite .
docker run -p 3000:3000 travellite
curl http://localhost:3000/health
# Expected: {"status": "ok"}
```

---

## Task Execution Guide

### Run All Tasks
```bash
# Start with Phase 1, then Phase 2, then Phase 3
# Each task blocks on dependencies

npm run tasks:execute
# Output: Real-time status updates as tasks complete
```

### Run Single Task
```bash
npm run task:execute T2.1
# Output: Planner Node implementation (status updates)
```

### Run Tasks in Parallel
```bash
# Tasks with same dependencies can run in parallel
npm run tasks:execute --parallel T2.3 T2.4 T2.5
# Output: All 3 API clients building simultaneously
```

### Track Progress
```bash
npm run tasks:status
# Output: Dashboard showing completion percentage
```

---

## Critical Path

```
T1.1 (Setup)
  ↓
T1.2 (Claude)
  ↓
T1.3 (LangGraph)
  ├─ T2.1 (Planner)
  │   ↓
  └─ T2.2 (Executor)
      ├─ T2.3 (Amadeus)
      ├─ T2.4 (Booking)
      ├─ T2.5 (TripAdvisor)
      ↓
      T2.6 (Reviewer)
          ↓
          T3.2 (WebSocket)
              ↓
              T3.6 (E2E Testing)

Total: 4-5 weeks (critical path), 14 weeks (1 person)
```

---

## Status Update Template

Use this template when updating task status:

```markdown
### T2.1: Planner Node

**Status:** 🟨 In Progress (60%)
**Updated:** 2026-09-21 14:30 UTC
**Completed:** Planning logic + caching ✓
**Remaining:** Unit tests
**Blocker:** None
**Next:** Write 4 unit tests

**Commits:** abc123d, def456e
**PR:** #42 (pending review)
```

---

## Success Criteria

✅ **MVP Launch (50 test sessions):**
- All 22 tasks complete
- Average session < 8s
- Average tokens < 4,000
- Cache hit rate > 50%
- Zero crashes
- Total cost < $2

✅ **Production Ready (100 DAU):**
- 95% uptime
- p95 latency < 10s
- Cost per session < $0.02
- User retention > 70%

