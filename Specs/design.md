# Travellite Design

**Project:** Travel Planning AI Agent (Browser Extension)  
**Format:** AI-Agent Optimized  
**Status:** Ready for Implementation  

---

## System Architecture

```
┌─────────────────────────────┐
│   Browser Extension         │
│  (TypeScript, Manifest V3)  │
│                             │
│ popup.html                  │
│ ├─ InputForm                │
│ ├─ StreamingProgress        │
│ ├─ ApprovalModal            │
│ └─ ItineraryDisplay         │
│                             │
│ background.js               │
│ ├─ WebSocket connection     │
│ ├─ Session management       │
│ └─ IndexedDB sync           │
└─────────────────────────────┘
           ↔ WSS (WebSocket)
┌─────────────────────────────┐
│   Fastify Backend           │
│  (TypeScript/Node)          │
│                             │
│ LangGraph State Machine     │
│ ├─ Planner node             │
│ ├─ Executor node            │
│ ├─ Reviewer node            │
│ └─ Approval node            │
│                             │
│ Claude API (streaming)      │
│ Redis cache (24h TTL)       │
│ External APIs               │
│ ├─ Amadeus (flights)        │
│ ├─ Booking (hotels)         │
│ └─ TripAdvisor (activities) │
└─────────────────────────────┘
```

---

## Data Flow

```
STEP 1: Input
User fills form → Validates locally → Sends vacation_config
  ↓
STEP 2: Planning
POST /plan → Generate task plan → Cache for 24h
  ↓
STEP 3: Fetching (Parallel)
Executor node → Promise.all([amadeus(), booking(), tripadvisor()])
  ↓
STEP 4: Analysis (Streaming)
Reviewer node → Analyze top 3 of each → Stream pros/cons to extension
  ↓
STEP 5: Approval (Paused)
Approval node → Broadcast awaiting_approval → User clicks approve/reject
  ↓
STEP 6: Itinerary
POST /session/{id}/approve → Return booking links → Save to IndexedDB
  ↓
STEP 7: Booking
User clicks links → External sites (Amadeus, Booking.com, TripAdvisor)
```

---

## Component Design

### Extension: InputForm
**File:** `popup.tsx`  
**Responsibility:** Capture vacation configuration  

**Interface:**
```typescript
interface InputFormProps {
  onSubmit: (config: VacationConfig) => Promise<void>;
  isLoading: boolean;
  error?: string;
}
```

**Implementation:**
```typescript
// Form validation
- destination: required, autocomplete
- departure_date: min=today, max=365d future
- return_date: min=departure+1d
- budget_usd: 100-100,000
- travelers: 1-20
- preferences: optional multi-select

// On submit
1. Validate locally
2. Save to IndexedDB (draft)
3. Call POST /plan
4. Get session_id and ws_url
5. Connect WebSocket
6. Transition to StreamingProgress
```

**Testing:**
- Valid input → onSubmit called
- Invalid dates → validation error shown
- Submit → form disabled, spinner shows
- Form restored on reopen

---

### Extension: StreamingProgress
**File:** `popup.tsx`  
**Responsibility:** Display real-time streaming updates  

**Interface:**
```typescript
interface StreamingProgressProps {
  sessionId: string;
  ws: WebSocket;
  onAnalysisComplete: (data: AnalysisData) => void;
}
```

**Implementation:**
```typescript
// WebSocket event handlers
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  
  if (msg.type === "node_start") {
    setCurrentNode(msg.node); // planner, executor, reviewer
    setElapsedTime(0);
  }
  
  if (msg.type === "token") {
    setTokenCount(prev => prev + 1);
  }
  
  if (msg.type === "awaiting_approval") {
    onAnalysisComplete(msg.data);
  }
  
  if (msg.type === "error") {
    setError(msg.message);
  }
};

// Display
- Node label: "Planning flights..." → "Analyzing options..." → "Ready for approval"
- Token count: 0 → 1,234 (live)
- Elapsed time: 0s → 7.5s
- Progress bar (visual indication)
```

**Testing:**
- Connect WebSocket → node_start received
- Receive tokens → token count increments
- Receive node_end → label changes
- Receive awaiting_approval → modal shows

---

### Extension: ApprovalModal
**File:** `approval.tsx`  
**Responsibility:** Display approval checkpoint  

**Interface:**
```typescript
interface ApprovalModalProps {
  approval: ApprovalState;
  onApprove: (category: "flight" | "accommodation" | "activities" | "all") => Promise<void>;
  onReject: (category: string) => void;
  onAdjust: () => void;
}
```

**Implementation:**
```typescript
// Display flight
- Title: approval.pending_bookings.flight.title
- Price: $approval.pending_bookings.flight.price
- Pros: approval.analysis.flight[flightId].pros
- Cons: approval.analysis.flight[flightId].cons
- Toggle: [Approve] [Reject]

// Display hotel
- Similar structure for accommodation

// Display activities
- List of 3 activities, each with toggle

// Footer
- Total: Sum of flight + (hotel × nights) + activities
- Buttons: [✓ Approve All] [← Adjust Search]

// On Approve All
1. POST /session/{sessionId}/approve
2. Receive approved_selections
3. Transition to ItineraryDisplay
4. Save to IndexedDB
```

**Testing:**
- Render with sample data → displays correctly
- Click approve → sends POST request
- Click reject → shows "Adjust Search" option
- Click "Adjust Search" → returns to form
- Pressing Escape → closes modal

---

### Extension: ItineraryDisplay
**File:** `itinerary.tsx`  
**Responsibility:** Display approved bookings with links  

**Interface:**
```typescript
interface ItineraryDisplayProps {
  itinerary: ApprovedItinerary;
  onNewSearch: () => void;
}
```

**Implementation:**
```typescript
// Display approved selections
const { selections } = itinerary;

// Flight
- Link: <a href={selections.flight.url}>{selections.flight.summary} → View & Book</a>
- onClick: window.open(url, '_blank')

// Accommodation
- Similar structure

// Activities
- List of activity links

// Persistence
- Save itinerary to IndexedDB on mount
- Load from IndexedDB on extension reopen
- Show "My Trips" list if multiple saved

// On "Plan Another Trip"
- Clear form
- Transition to InputForm
```

**Testing:**
- Render itinerary → links display
- Click link → opens in new tab (not closing extension)
- Close extension, reopen → itinerary restored
- "Plan Another Trip" → form shows

---

### Backend: Planner Node
**File:** `nodes/planner.ts`  
**Responsibility:** Generate booking plan  

**Algorithm:**
```typescript
async function planner(state: TravelliteState): Promise<TravelliteState> {
  const { vacation_config } = state;
  
  // Check cache
  const cacheKey = `plan:${destination}:${dateRange}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    state.plan = JSON.parse(cached);
    state.from_cache = true;
    return state;
  }
  
  // Generate plan with Claude
  const prompt = `
    Generate a booking plan for:
    - Destination: ${destination}
    - Dates: ${departure_date} to ${return_date}
    - Budget: $${budget_usd}
    - Travelers: ${travelers}
    - Preferences: ${preferences.join(", ")}
    
    Return JSON with:
    - tasks: [{task_name, order, prerequisites}]
    - budget_allocation: {flights: %, accommodations: %, activities: %}
  `;
  
  const plan = await claude.stream(prompt);
  
  // Validate JSON
  if (!isValidPlan(plan)) {
    throw new Error("Invalid plan from Claude");
  }
  
  // Cache for 24h
  await redis.set(cacheKey, JSON.stringify(plan), { ttl: 86400 });
  
  state.plan = plan;
  state.from_cache = false;
  return state;
}
```

**Testing:**
- Valid config → plan generated
- Cache hit → skips Claude, returns cached
- Cache miss → calls Claude, caches result
- Invalid JSON from Claude → retry or error

---

### Backend: Executor Node
**File:** `nodes/executor.ts`  
**Responsibility:** Fetch flights, hotels, activities in parallel  

**Algorithm:**
```typescript
async function executor(state: TravelliteState): Promise<TravelliteState> {
  const { vacation_config } = state;
  
  // Parallel fetch
  const [flights, hotels, activities] = await Promise.all([
    amadeus.searchFlights({
      origin: detectOrigin(),
      destination: vacation_config.destination,
      departure: vacation_config.departure_date,
      return: vacation_config.return_date,
      adults: vacation_config.travelers
    }).catch(err => ({
      error: err.message,
      results: getDefaultFlights() // fallback
    })),
    
    booking.searchHotels({
      city: vacation_config.destination,
      checkin: vacation_config.departure_date,
      checkout: vacation_config.return_date,
      guests: vacation_config.travelers
    }).catch(err => ({
      error: err.message,
      results: getDefaultHotels()
    })),
    
    tripadvisor.searchActivities({
      location: vacation_config.destination,
      interests: vacation_config.preferences,
      priceRange: calculatePriceRange(vacation_config.budget_usd)
    }).catch(err => ({
      error: err.message,
      results: getDefaultActivities()
    }))
  ]);
  
  // Parse and normalize
  state.results = {
    flights: flights.results.map(f => parseFlightOption(f)).slice(0, 20),
    accommodations: hotels.results.map(h => parseHotelOption(h)).slice(0, 20),
    activities: activities.results.map(a => parseActivityOption(a)).slice(0, 20)
  };
  
  return state;
}
```

**Testing:**
- All 3 APIs succeed → results returned
- One API fails → continue with other 2
- All APIs fail → show error, offer retry
- Results parsed correctly (prices in USD, etc.)

---

### Backend: Reviewer Node
**File:** `nodes/reviewer.ts`  
**Responsibility:** Analyze top 3 options per category, stream results  

**Algorithm:**
```typescript
async function reviewer(state: TravelliteState): Promise<TravelliteState> {
  const { results } = state;
  const analysis = {};
  
  // Analyze top 3 of each category
  for (const category of ["flights", "accommodations", "activities"]) {
    const options = results[category].slice(0, 3);
    
    for (const option of options) {
      const prompt = `
        Analyze this ${category.slice(0, -1)}:
        ${JSON.stringify(option)}
        
        User budget: $${state.vacation_config.budget_usd}
        User preferences: ${state.vacation_config.preferences.join(", ")}
        
        Return JSON:
        {
          "pros": ["pro1", "pro2", "pro3"],
          "cons": ["con1", "con2", "con3"],
          "recommended": boolean,
          "rationale": "explanation"
        }
      `;
      
      const optionAnalysis = await claude.stream(prompt);
      analysis[option.id] = optionAnalysis;
      
      // Stream to extension immediately
      broadcastToExtension({
        type: "analysis",
        category,
        option_id: option.id,
        data: optionAnalysis
      });
    }
    
    // Mark first (best) as recommended
    const firstOption = options[0];
    analysis[firstOption.id].recommended = true;
  }
  
  state.analysis = analysis;
  return state;
}
```

**Testing:**
- Analysis generated for top 3 per category
- Pros/cons are meaningful, not generic
- First option marked recommended
- Streaming works (messages sent as received)

---

### Backend: Approval Node
**File:** `nodes/approval.ts`  
**Responsibility:** Pause for user approval  

**Algorithm:**
```typescript
async function approval(state: TravelliteState): Promise<TravelliteState> {
  // Build approval state
  const approvalState: ApprovalState = {
    pending_bookings: {
      flight: state.results.flights[0],
      accommodation: state.results.accommodations[0],
      activities: state.results.activities.slice(0, 3)
    },
    approval_status: {
      flight: "pending",
      accommodation: "pending",
      activities: "pending"
    },
    approved_selections: {}
  };
  
  // Save state
  inMemorySessions[state.session_id].approval = approvalState;
  await db.sessions.update(state.session_id, { approval: approvalState });
  
  // Broadcast to extension
  broadcastToExtension({
    type: "awaiting_approval",
    approval: approvalState
  });
  
  // Pause execution (wait for approval)
  state.awaiting_approval = true;
  return state;
}
```

**Testing:**
- Approval modal shows with correct data
- User approval handled by separate endpoint
- State persists across session

---

### Backend: POST /plan Endpoint
**File:** `routes/plan.ts`  

**Endpoint:**
```
POST /plan
Content-Type: application/json

{
  "vacation_config": {
    "destination": "Paris",
    "departure_date": "2024-12-01T00:00:00Z",
    "return_date": "2024-12-07T00:00:00Z",
    "budget_usd": 3000,
    "travelers": 2,
    "preferences": ["beach", "museums"]
  }
}
```

**Response:**
```json
{
  "session_id": "uuid",
  "ws_url": "wss://backend/stream/uuid"
}
```

**Logic:**
```typescript
app.post("/plan", async (req, res) => {
  const { vacation_config } = req.body;
  
  // Validate
  if (!isValidConfig(vacation_config)) {
    return res.status(400).json({ error: "Invalid config" });
  }
  
  // Generate session
  const sessionId = crypto.randomUUID();
  
  // Start graph execution async (don't wait)
  executeGraph(vacation_config, sessionId)
    .catch(err => console.error(`Session ${sessionId} failed:`, err));
  
  // Return immediately
  res.json({
    session_id: sessionId,
    ws_url: `wss://${req.headers.host}/stream/${sessionId}`
  });
});
```

---

### Backend: WebSocket /stream/{sessionId}
**File:** `routes/stream.ts`  

**Endpoint:**
```
WSS /stream/{sessionId}
```

**Messages Sent to Client:**
```json
{
  "type": "node_start",
  "node": "planner",
  "state": {...}
}

{
  "type": "token",
  "token": "str"
}

{
  "type": "node_end",
  "node": "planner",
  "duration_ms": 1234
}

{
  "type": "awaiting_approval",
  "approval": {...}
}

{
  "type": "error",
  "message": "..."
}
```

**Logic:**
```typescript
wss.on("connection", (ws, req) => {
  const sessionId = req.url.split("/")[2];
  const session = inMemorySessions[sessionId];
  
  if (!session) {
    ws.close(404);
    return;
  }
  
  // Bind to session
  session.ws = ws;
  
  // Graph sends updates via broadcastToExtension()
  // which writes to session.ws
});
```

---

### Backend: POST /session/{sessionId}/approve
**File:** `routes/approve.ts`  

**Endpoint:**
```
POST /session/{sessionId}/approve
Content-Type: application/json

{
  "approved": true,
  "category": "all" | "flight" | "accommodation" | "activities"
}
```

**Response:**
```json
{
  "status": "approved",
  "approved_selections": {
    "flight": {
      "url": "https://amadeus.com/...",
      "summary": "United UA123 • $420"
    },
    "accommodation": {
      "url": "https://booking.com/...",
      "summary": "Marriott Paris • $150/night"
    },
    "activities": [
      {
        "url": "https://tripadvisor.com/...",
        "summary": "Louvre Museum • $25"
      }
    ]
  }
}
```

**Logic:**
```typescript
app.post("/session/:sessionId/approve", async (req, res) => {
  const { sessionId } = req.params;
  const { approved, category } = req.body;
  const session = inMemorySessions[sessionId];
  
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }
  
  if (approved) {
    // Mark category as approved
    session.approval.approval_status[category] = "approved";
    
    // Build booking URL for approved option
    const option = session.approval.pending_bookings[category];
    session.approval.approved_selections[category] = {
      url: option.url,
      summary: generateSummary(option)
    };
  } else {
    session.approval.approval_status[category] = "rejected";
  }
  
  // Log for analytics
  db.approvals.create({
    session_id: sessionId,
    category,
    approved,
    timestamp: new Date()
  });
  
  res.json({
    status: approved ? "approved" : "rejected",
    approved_selections: session.approval.approved_selections
  });
});
```

---

## Error Handling

### Network Errors
```
Error: Connection lost
Handler:
  1. Show "Connection lost. Retrying..."
  2. Exponential backoff: 1s, 2s, 4s, 8s, 16s
  3. After 3 retries: show "Contact support"
  4. Save session state before retry
```

### API Errors
```
Error: Amadeus 429 (rate limit)
Handler:
  1. Queue request
  2. Retry with exponential backoff
  3. If max retries exceeded, use cached options
  4. Continue with other APIs
  
Error: Booking.com timeout
Handler:
  1. Return empty results (fallback)
  2. Continue with Amadeus + TripAdvisor
  3. Show warning in UI
```

### Claude Errors
```
Error: Claude timeout
Handler:
  1. Retry with simpler prompt
  2. If still fails, skip analysis for that option
  3. Continue with next option
  
Error: Invalid JSON from Claude
Handler:
  1. Retry up to 3 times
  2. If all fail, show generic pros/cons
```

---

## Testing Strategy

### Unit Tests
```
✓ Planner node: plan generation, caching
✓ Executor node: API calls, parsing, fallbacks
✓ Reviewer node: analysis generation, streaming
✓ Approval node: state management
✓ API clients: request/response parsing
✓ IndexedDB: CRUD operations, TTL
```

### Integration Tests
```
✓ Full flow: input → plan → fetch → analyze → approve → itinerary
✓ API fallbacks: one API fails → continue with others
✓ WebSocket streaming: events flow correctly
✓ IndexedDB persistence: data survives crash
✓ Reconnection: WebSocket reconnects and resumes
```

### E2E Tests
```
✓ 50 manual sessions across different destinations
✓ Network interruption: pull cable → reconnect → resume
✓ Extension crash: crash mid-planning → reopen → resume
✓ Booking links: all links valid (no 404s)
✓ Performance: sessions complete in < 8s
✓ Cost: tokens < 4,000 per session
```

