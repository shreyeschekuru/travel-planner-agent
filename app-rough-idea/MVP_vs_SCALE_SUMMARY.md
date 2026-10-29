# Travellite: MVP vs 1000+ DAU Quick Reference

---

## MVP Architecture (Proof of Concept)

### Technology Stack
```
Extension (TypeScript)
    ↕ (WebSocket)
Fastify (Node.js) + LangGraph
    ↕
Redis (sessions + cache)
    ↕
External APIs (Amadeus, Booking, TripAdvisor)
```

### Deployment
```
Single Fastify server on Render.com or Heroku
├─ 2GB RAM
├─ 1 Redis instance (free tier)
└─ Docker container (~200MB)
```

### Performance
| Metric | Target |
|--------|--------|
| Time to first token | <2s |
| Full plan generation | 4-8s |
| Concurrent users | 5-10 |
| Cost per session | $0.021 |
| Monthly spend | $10-20 (Claude) + $50 (infra) = **$70** |

### Cost Breakdown (Monthly)
```
Claude API (1000 sessions × $0.021)        $21
Server (Render web: $7/month)              $7
Redis (Upstash free)                       $0
Domain + SSL                               $0
─────────────────────────────────────────
TOTAL                                      $28/month
```

### Graph Structure
```
INPUT (vacation_config)
    ↓
[Planner Node]
    → Generate task plan + budget allocation
    → Cache for 24h
    ↓
[Executor Node] (parallel)
    → amadeus.flights()
    → booking.hotels()
    → tripadvisor.activities()
    ↓
[Reviewer Node]
    → Analyze top 3 options per category
    → Stream pros/cons to extension
    ↓
[Approval Node]
    → Pause execution
    → Show summary + booking links
    → User manually books via links
    ↓
OUTPUT (trip itinerary)
```

### Key Optimizations
1. **Prompt caching:** Destination plans reused 24h (Paris trip #2 = -$0.01)
2. **Streaming only:** Don't send raw API responses to Claude
3. **Early termination:** If flights = 80% of budget, stop recommending hotels
4. **Parallel tasks:** Fetch flights + hotels + activities simultaneously
5. **Structured JSON:** No parsing, deterministic outputs

### Extension Features (MVP)
```
Popup UI
├─ Input form (destination, dates, budget, preferences)
├─ Real-time streaming (node progress + token stream)
├─ Results display (flights, hotels, activities with pros/cons)
└─ Approval modal (summary + manual booking links)

Background
├─ WebSocket connection (reconnect on error)
├─ IndexedDB persistence (offline access to past sessions)
└─ Session management (resume from saved state)

No vacation planner webpage (Phase 2)
No backend database (Phase 2)
```

### Validation Targets
- [ ] <2s time to first token streaming
- [ ] <8s full plan generation
- [ ] <4K tokens per session average
- [ ] Cache hit rate >50% for same destinations
- [ ] 3+ test users validate UX flow

---

## Scale Architecture (1000+ DAU)

### What Changes
```
Input: 1000 daily active users
       100 concurrent peak sessions
       
Output: Horizontal scaling
        API quota management
        Persistent observability
```

### Technology Stack (Scale)
```
                     Load Balancer
                   (Sticky sessions)
                          │
        ┌─────────────┬───┴────┬─────────────┐
        │             │        │             │
    Fastify 1     Fastify 2  Fastify 3   Fastify N
    (Node pod)   (Node pod) (Node pod)  (Node pod)
        │             │        │             │
        └─────────────┼────────┴─────────────┘
                      │
          ┌───────────┼───────────┐
          │           │           │
        Redis      Celery      PostgreSQL
      (Cluster)    (Queue)     (Logs)
          │
      API Quota Manager
      (Rate limit enforcement)
```

### Deployment
```
Kubernetes (EKS) or managed container service
├─ 3-5 Fastify pods (auto-scale 5-20 based on load)
├─ Redis Cluster (high availability, persistence)
├─ Celery workers (2-3, for async task queues)
└─ PostgreSQL (RDS, for audit logs)
```

### Performance
| Metric | Target |
|--------|--------|
| Time to first token | <2s (same) |
| Full plan generation | 4-8s (same) |
| Concurrent users | 100+ |
| Cost per session | $0.013 (38% cheaper due to caching) |
| Cache hit rate | 60-70% |
| Monthly spend | **$150-400** (infra) + **$130** (API) = **$280** |

### Cost Breakdown (Monthly at 50K sessions)
```
Claude API (50K × $0.013)                 $650
Compute (3-5 pods × $60/mo)               $300
Redis Cluster (6GB, HA)                   $80
Celery infrastructure                     $30
PostgreSQL (RDS, small)                   $40
Load balancer                             $15
─────────────────────────────────────────
TOTAL                                     $1,115/month

Per user cost: $1,115 / 1000 = $1.12/month
```

### Scaling Mechanics

#### 1. Redis State Management
```typescript
// Before: State in-memory (lost on restart)
const state = plannerState;

// After: Persist to Redis (survives pod death)
await redis.setex(`session:${sessionId}`, 3600, JSON.stringify(state));

// On pod crash → new pod fetches state from Redis
// Resume from exact checkpoint
```

#### 2. Prompt Caching (Cost Lever #1)
```
Peak hour: 100 concurrent sessions
10 unique destinations (Paris, NYC, Tokyo, etc.)

Scenario A (No caching):
- 100 sessions × 2,000 tokens (planner) = 200K tokens
- Cost: 200K × $0.001 = $0.20 per peak hour

Scenario B (60% cache hit):
- 40 cache misses × 2,000 tokens = 80K tokens
- 60 cache hits × 0 tokens = 0 tokens
- Cost: 80K × $0.001 = $0.08 per peak hour
→ Savings: 60% per hour × 24h × 30d = $4,320/year
```

#### 3. API Quota Queue (Cost Lever #2)
```
Amadeus limit: 600 calls/min
Peak: 120 users × 5 flights calls = 600 calls needed

Without queue:
- Rate limit errors → retries → more tokens wasted
- Fallback to expensive API (Skyscanner)

With queue:
- Queue requests, process in order
- Never hit limit
- No fallback costs
```

#### 4. Celery Background Tasks (Latency Lever)
```
Large API responses (50 flights) slow down Reviewer

Before:
- User waits 12s for all analysis → poor UX

After:
- Streaming top 3 flights in 3s
- Remaining 47 analyzed in background
- User gets fast UX + complete results
```

#### 5. Database Logging (Optional)
```sql
-- Track trends for cost optimization
SELECT destination, COUNT(*) as trip_count, AVG(total_cost) as avg_spend
FROM session_logs
GROUP BY destination
ORDER BY trip_count DESC;

-- Alert if costs drift
SELECT DATE_TRUNC('hour', timestamp) as hour, AVG(total_tokens_used) as avg_tokens
FROM session_logs
GROUP BY hour
HAVING AVG(total_tokens_used) > 5000  -- Alert if > 5K
```

### Extension Features (Scale)
```
Same as MVP, plus:

Background Improvements:
├─ Exponential backoff for WebSocket reconnection
├─ Local queue for selections (upload in batch)
└─ Better error messaging (know when to retry vs error)

Analytics (Optional):
├─ Track which destinations are popular
├─ Monitor user approval rate (should be >80%)
└─ Cost tracking per trip
```

---

## Scaling Strategy (MVP → 1000+ DAU)

### Week 0-2: MVP Validation
```
Deploy single Fastify server
Run 10 manual test sessions
Measure:
  - Time to first token
  - Cache hit rate
  - Token usage per session
Goal: Validate <2K tokens with caching
```

### Week 2-4: Add Redis + Caching
```
Minimal change: Add cache layer to Planner
Expected: 40-50% reduction in repeat destination queries
No code restructure needed yet
```

### Week 4-8: First 100 DAU
```
If sustained growth:
  - Add second Fastify pod
  - Implement sticky sessions (load balancer)
  - Monitor memory/CPU
```

### Week 8-16: 100 → 1000 DAU
```
Restructure state → Redis (prepare for scale)
Add Celery (async analysis)
Implement API quota manager
Set up PostgreSQL logging
```

### Week 16+: 1000+ DAU Operations
```
Auto-scaling based on load
Kubernetes deployment
Cost optimization (monitor caching effectiveness)
Potential: Migrate to serverless (Lambda) if costs spike
```

---

## Token Cost Trajectory

```
                Cost per session ($)
                      ▲
                      │    No caching
                      │    (MVP worst case)
                $0.04 │    /
                      │   /
                $0.03 │  /
                      │ /  ← MVP with caching
                $0.02 │/
                      │  ✓ Stable at scale with cache
                $0.01 │─────────────────
                      │
                $0.00 └──────────────────→ Daily active users
                      0   100  500  1000+
                      
Insight: As you scale, caching efficiency improves
(more repeat destinations) → cost per session drops
```

---

## Approval Flow (All Bookings)

### User Journey

```
1. User inputs trip details
   ↓
2. Agent generates plan + fetches results
   ↓
3. [APPROVAL CHECKPOINT]
   Agent pauses
   Extension shows modal:
   ┌─────────────────────────────────┐
   │ ✈️ Flight: United • $420        │
   │ 🏨 Hotel: Marriott • $150/night │
   │ 🎭 Activities: 3 saved          │
   │                                 │
   │ [View & Book Flight →]          │
   │ [View & Book Hotel →]           │
   │ [Save Itinerary] [Adjust Search]│
   └─────────────────────────────────┘
   ↓
4. User manually books (clicks links)
   ↓
5. Selections saved to IndexedDB
   ↓
6. (Future) Agent continues for multi-leg trips
```

### Why Manual Booking
- ✅ User maintains control
- ✅ Agent doesn't risk booking wrong dates/prices
- ✅ MVP simplicity (no payment integration)
- ✅ User can price-check on multiple sites
- ✅ Liability stays with user

### Why Approval for All
- ✅ Builds user trust (transparency)
- ✅ Catches agent errors early
- ✅ Users see reasoning (pros/cons)
- ✅ MVP default: better to over-notify than under-notify

**Future optimization (Phase 2+):**
```
After 100+ sessions, learn approval patterns:
- If user always approves flights immediately
  → Skip approval for flights, still approve hotels
- If user never adjusts recommendations
  → Auto-approve, show summary asynchronously
```

---

## Implementation Checklist

### MVP (Week 0-2)
- [ ] TypeScript + Fastify backend scaffolding
- [ ] LangGraph state + 3 nodes (planner/executor/reviewer)
- [ ] Amadeus/Booking/TripAdvisor API integration
- [ ] Extension popup + WebSocket streaming
- [ ] IndexedDB persistence
- [ ] Claude API integration (streaming + caching)
- [ ] Approval node + manual booking links
- [ ] Cost tracker (log tokens per session)

### Scaling (Week 8+, if you hit 100 DAU)
- [ ] Redis setup + state migration
- [ ] Load balancer + 2nd pod deployment
- [ ] Celery task queue
- [ ] API quota manager + rate limiting
- [ ] PostgreSQL logging
- [ ] LangSmith observability
- [ ] Kubernetes manifests
- [ ] Auto-scaling policies

---

## Success Metrics

### MVP Validation
```
Launch extension → Recruit 5-10 beta users → Run 50 sessions
Target metrics:
  ✓ Average session: <8s
  ✓ Average tokens: <4,000
  ✓ Cache hit rate: >50%
  ✓ User approval rate: >80%
  ✓ Bug-free core flow: 3+ test cycles
  ✓ Total cost: <$50/50 sessions = $0.50 cost of goods
```

### 1000+ DAU Readiness
```
1000 DAU = ~50,000 sessions/month

Target metrics:
  ✓ Latency p95: <10s
  ✓ Availability: 99.5% uptime
  ✓ Cost per session: <$0.02
  ✓ Monthly bill: <$1,500
  ✓ Cache hit rate: >60%
  ✓ Error rate: <1%
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Redis single-point-of-failure | Use Redis Cluster (HA) at scale |
| API rate limits (Amadeus 600/min) | Implement queue manager + retry logic |
| LangGraph.js feature lag | Monitor releases, fallback to Python nodes if needed |
| Token cost explosion | Implement prompt caching + early termination |
| User privacy (saving sessions) | Use end-to-end encryption for sensitive data in IndexedDB |
| Extension crashes mid-plan | Checkpoint after every node, resume on reconnect |

