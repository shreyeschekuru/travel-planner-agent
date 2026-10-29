# Travellite: Approval Flow (All Bookings, Manual Booking)

---

## Overview

**MVP requirement:** Every booking recommendation requires explicit user approval before displaying booking links.

**User action:** User clicks links to manually book (agent doesn't book for them).

**UI pattern:** Modal approval checkpoint after agent completes analysis, before showing "Book" links.

---

## State Schema for Approval

```typescript
interface ApprovalState {
  // What needs approval
  pending_bookings: {
    flight?: {
      id: string;
      airline: string;
      price: number;
      departure: ISO8601;
      return: ISO8601;
      url: string;
      pros: string[];
      cons: string[];
      recommended: boolean;
    };
    accommodation?: {
      id: string;
      name: string;
      price_per_night: number;
      rating: number;
      checkin: ISO8601;
      checkout: ISO8601;
      url: string;
      pros: string[];
      cons: string[];
      recommended: boolean;
    };
    activities?: Array<{
      id: string;
      title: string;
      price: number;
      rating: number;
      url: string;
      pros: string[];
      cons: string[];
      recommended: boolean;
    }>;
  };

  // Approval status
  approval_status: {
    flight: "pending" | "approved" | "rejected";
    accommodation: "pending" | "approved" | "rejected";
    activities: "pending" | "approved" | "rejected";
  };

  // Approved selections (saved to IndexedDB)
  approved_selections: {
    flight?: { url: string; summary: string; approved_at: ISO8601 };
    accommodation?: { url: string; summary: string; approved_at: ISO8601 };
    activities?: Array<{ url: string; summary: string; approved_at: ISO8601 }>;
  };

  // Audit
  approval_timestamp: ISO8601;
  approval_notes?: string;
}
```

---

## Graph Execution Flow with Approval

```
START
  ↓
[Planner Node]
  Generate task plan
  Budget allocation
  ↓
[Executor Node]
  Fetch flights (top 10)
  Fetch hotels (top 10)
  Fetch activities (top 20)
  ↓
[Reviewer Node]
  Analyze top 3 options (each category)
  Stream pros/cons
  Return structured results
  ↓
[Approval Node] ← NEW
  Pause execution
  Save recommendations to state
  Signal extension: "Ready for approval"
  ↓
EXTENSION: Show approval modal
  User reviews summaries
  User clicks "Approve"
  ↓
[Approval Handler] (backend node or extension callback)
  Mark selections as approved
  Unlock booking links
  ↓
EXTENSION: Display itinerary with live booking links
  ↓
User clicks "View & Book Flight"
  → Opens Amadeus/Kayak/etc in new tab
  → User manually completes booking
  ↓
User returns to extension (or continues)
  Saves confirmation to itinerary
  ↓
END
```

---

## Backend Implementation

### Approval Node Definition

```typescript
// approval.node.ts

const approval_node = async (state: TravelliteState): Promise<TravelliteState> => {
  // Extract top recommendations from Reviewer results
  const topFlight = state.results.flights?.[0];
  const topHotel = state.results.accommodations?.[0];
  const topActivities = state.results.activities?.slice(0, 3) || [];

  // Validate all data exists
  if (!topFlight || !topHotel) {
    return {
      ...state,
      error: "Insufficient data for approval (missing flight or hotel)",
    };
  }

  // Build approval state
  const approvalState: ApprovalState = {
    pending_bookings: {
      flight: {
        id: topFlight.id,
        airline: topFlight.title,
        price: topFlight.price,
        departure: state.vacation_config.departure_date,
        return: state.vacation_config.return_date,
        url: topFlight.url,
        pros: topFlight.pros,
        cons: topFlight.cons,
        recommended: topFlight.recommended ?? true,
      },
      accommodation: {
        id: topHotel.id,
        name: topHotel.title,
        price_per_night: topHotel.price,
        rating: topHotel.rating,
        checkin: state.vacation_config.departure_date,
        checkout: state.vacation_config.return_date,
        url: topHotel.url,
        pros: topHotel.pros,
        cons: topHotel.cons,
        recommended: topHotel.recommended ?? true,
      },
      activities: topActivities.map((act) => ({
        id: act.id,
        title: act.title,
        price: act.price,
        rating: act.rating,
        url: act.url,
        pros: act.pros,
        cons: act.cons,
        recommended: act.recommended ?? false,
      })),
    },
    approval_status: {
      flight: "pending",
      accommodation: "pending",
      activities: "pending",
    },
    approved_selections: {},
    approval_timestamp: new Date().toISOString(),
  };

  // Signal to extension: "Waiting for approval"
  // (In real implementation, broadcast via WebSocket)
  broadcastToExtension(state.session_id, {
    type: "awaiting_approval",
    approval_data: approvalState,
  });

  // Return state with approval data (pauses graph execution)
  return {
    ...state,
    approval: approvalState,
    awaiting_approval: true,
  };
};
```

### Approval Handler (When User Clicks "Approve")

```typescript
// approval.handler.ts (runs when user sends approval)

app.post("/session/:sessionId/approve", async (req, res) => {
  const { approved, category, notes } = req.body;
  // category: "flight" | "accommodation" | "activities" | "all"

  const session = await getSession(req.params.sessionId);
  const approval = session.approval as ApprovalState;

  if (!approval) {
    return res.status(400).json({ error: "No pending approval" });
  }

  if (approved) {
    // Mark approvals as approved
    if (category === "all" || category === "flight") {
      approval.approval_status.flight = "approved";
      approval.approved_selections.flight = {
        url: approval.pending_bookings.flight!.url,
        summary: `${approval.pending_bookings.flight!.airline} • $${approval.pending_bookings.flight!.price}`,
        approved_at: new Date().toISOString(),
      };
    }

    if (category === "all" || category === "accommodation") {
      approval.approval_status.accommodation = "approved";
      approval.approved_selections.accommodation = {
        url: approval.pending_bookings.accommodation!.url,
        summary: `${approval.pending_bookings.accommodation!.name} • $${approval.pending_bookings.accommodation!.price_per_night}/night`,
        approved_at: new Date().toISOString(),
      };
    }

    if (category === "all" || category === "activities") {
      approval.approval_status.activities = "approved";
      approval.approved_selections.activities =
        approval.pending_bookings.activities?.map((act) => ({
          url: act.url,
          summary: `${act.title} • $${act.price}`,
          approved_at: new Date().toISOString(),
        })) || [];
    }

    // Log approval decision
    await logApprovalDecision(req.params.sessionId, {
      action: "approved",
      category,
      notes,
      timestamp: new Date().toISOString(),
    });

    // Save updated state
    session.awaiting_approval = false;
    session.approval = approval;
    await saveSession(session);

    // Signal extension: Approved
    broadcastToExtension(req.params.sessionId, {
      type: "approval_confirmed",
      approved_selections: approval.approved_selections,
    });

    res.json({
      status: "approved",
      approved_selections: approval.approved_selections,
    });
  } else {
    // User rejected → allow refinement
    approval.approval_status[category] = "rejected";

    // Log rejection
    await logApprovalDecision(req.params.sessionId, {
      action: "rejected",
      category,
      notes,
      timestamp: new Date().toISOString(),
    });

    await saveSession(session);

    // Signal extension: Rejected (offer to adjust)
    broadcastToExtension(req.params.sessionId, {
      type: "approval_rejected",
      category,
      reason: notes,
    });

    res.json({
      status: "rejected",
      category,
      suggestion: "Adjust search criteria and try again",
    });
  }
});
```

---

## Extension Implementation

### Approval Modal UI

```html
<!-- approval-modal.html -->
<div id="approval-modal" class="modal" style="display: none;">
  <div class="modal-overlay"></div>

  <div class="modal-content">
    <div class="modal-header">
      <h2>✈️ Your Trip Summary</h2>
      <p class="subtitle">Review and approve your recommendations</p>
    </div>

    <div class="modal-body">
      <!-- Flight Card -->
      <div class="booking-card" id="flight-card">
        <div class="card-header">
          <span class="emoji">✈️</span>
          <h3>Flight</h3>
          <span class="recommended-badge">Recommended</span>
        </div>

        <div class="card-content">
          <div class="price-info">
            <span class="airline" id="flight-airline">--</span>
            <span class="price" id="flight-price">$0</span>
          </div>

          <div class="date-info">
            <span id="flight-dates">-- to --</span>
          </div>

          <div class="analysis">
            <div class="pros">
              <strong>Pros:</strong>
              <ul id="flight-pros"></ul>
            </div>
            <div class="cons">
              <strong>Cons:</strong>
              <ul id="flight-cons"></ul>
            </div>
          </div>

          <div class="actions">
            <a id="flight-link" href="#" target="_blank" class="view-btn">
              View Flight Details →
            </a>
            <div class="approval-buttons">
              <button onclick="approveCategory('flight')" class="approve-btn">
                ✓ Approve
              </button>
              <button onclick="rejectCategory('flight')" class="reject-btn">
                ✗ Not interested
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Accommodation Card (similar structure) -->
      <div class="booking-card" id="accommodation-card">
        <div class="card-header">
          <span class="emoji">🏨</span>
          <h3>Hotel</h3>
          <span class="recommended-badge">Recommended</span>
        </div>

        <div class="card-content">
          <div class="price-info">
            <span class="hotel-name" id="hotel-name">--</span>
            <span class="price" id="hotel-price">$0 <small>/night</small></span>
            <span class="rating" id="hotel-rating">★ --</span>
          </div>

          <div class="date-info">
            <span id="hotel-dates">-- to --</span>
            <span class="nights-count" id="hotel-nights">(-- nights)</span>
          </div>

          <div class="analysis">
            <div class="pros">
              <strong>Pros:</strong>
              <ul id="hotel-pros"></ul>
            </div>
            <div class="cons">
              <strong>Cons:</strong>
              <ul id="hotel-cons"></ul>
            </div>
          </div>

          <div class="actions">
            <a id="hotel-link" href="#" target="_blank" class="view-btn">
              View Hotel Details →
            </a>
            <div class="approval-buttons">
              <button onclick="approveCategory('accommodation')" class="approve-btn">
                ✓ Approve
              </button>
              <button onclick="rejectCategory('accommodation')" class="reject-btn">
                ✗ Not interested
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Activities Cards (scrollable list) -->
      <div class="booking-card" id="activities-card">
        <div class="card-header">
          <span class="emoji">🎭</span>
          <h3>Activities</h3>
          <span class="count" id="activity-count">(3 recommended)</span>
        </div>

        <div class="card-content">
          <div id="activities-list" class="activities-list">
            <!-- Dynamically populated -->
          </div>

          <div class="approval-buttons">
            <button onclick="approveCategory('activities')" class="approve-btn">
              ✓ Approve All
            </button>
            <button onclick="rejectCategory('activities')" class="reject-btn">
              ✗ Skip
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Summary Footer -->
    <div class="modal-footer">
      <div class="total-cost">
        <strong>Total estimated cost:</strong>
        <span id="total-cost-amount">$0</span>
      </div>

      <div class="final-actions">
        <button
          onclick="approveAll()"
          class="primary-btn"
          id="approve-all-btn"
        >
          ✓ Approve All & Show Booking Links
        </button>
        <button onclick="adjustSearch()" class="secondary-btn">
          ← Adjust Search
        </button>
      </div>
    </div>
  </div>
</div>

<style>
  .modal {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .modal-overlay {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
  }

  .modal-content {
    position: relative;
    background: white;
    border-radius: 12px;
    max-width: 600px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  }

  .modal-header {
    padding: 24px;
    border-bottom: 1px solid #e0e0e0;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
  }

  .modal-header h2 {
    margin: 0;
    font-size: 24px;
  }

  .subtitle {
    margin: 8px 0 0 0;
    opacity: 0.9;
    font-size: 14px;
  }

  .booking-card {
    margin: 16px;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    overflow: hidden;
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px;
    background: #f5f5f5;
    font-weight: 600;
  }

  .emoji {
    font-size: 24px;
  }

  .recommended-badge {
    margin-left: auto;
    background: #4caf50;
    color: white;
    padding: 4px 8px;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
  }

  .card-content {
    padding: 16px;
  }

  .price-info {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 8px;
    font-size: 18px;
    font-weight: 600;
  }

  .price {
    color: #2196f3;
  }

  .analysis {
    margin: 16px 0;
    padding: 12px;
    background: #fafafa;
    border-radius: 4px;
    font-size: 13px;
  }

  .pros {
    margin-bottom: 12px;
  }

  .pros strong {
    color: #4caf50;
  }

  .cons strong {
    color: #f44336;
  }

  .pros ul,
  .cons ul {
    margin: 6px 0 0 20px;
    padding: 0;
  }

  .pros li::marker {
    color: #4caf50;
  }

  .cons li::marker {
    color: #f44336;
  }

  .actions {
    margin-top: 16px;
  }

  .view-btn {
    display: inline-block;
    color: #2196f3;
    text-decoration: none;
    font-weight: 500;
    margin-bottom: 12px;
  }

  .view-btn:hover {
    text-decoration: underline;
  }

  .approval-buttons {
    display: flex;
    gap: 8px;
  }

  .approve-btn {
    flex: 1;
    padding: 10px 16px;
    background: #4caf50;
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
  }

  .approve-btn:hover {
    background: #45a049;
  }

  .reject-btn {
    flex: 1;
    padding: 10px 16px;
    background: #f5f5f5;
    color: #666;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
  }

  .reject-btn:hover {
    background: #eeeeee;
  }

  .modal-footer {
    padding: 24px;
    border-top: 1px solid #e0e0e0;
    background: #f5f5f5;
  }

  .total-cost {
    margin-bottom: 16px;
    font-size: 18px;
  }

  .primary-btn {
    display: block;
    width: 100%;
    padding: 14px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 600;
    font-size: 16px;
    margin-bottom: 12px;
  }

  .primary-btn:hover {
    opacity: 0.9;
  }

  .secondary-btn {
    display: block;
    width: 100%;
    padding: 12px;
    background: white;
    color: #666;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
  }

  .secondary-btn:hover {
    background: #fafafa;
  }
</style>
```

### Approval Modal Logic (popup.js)

```typescript
// approval.handler.ts (extension)

let currentApprovalState: ApprovalState | null = null;

// Receive approval data from backend
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "awaiting_approval") {
    currentApprovalState = msg.approval_data;
    displayApprovalModal(msg.approval_data);
  }

  if (msg.type === "approval_confirmed") {
    displayBookingItinerary(msg.approved_selections);
  }
});

function displayApprovalModal(approval: ApprovalState) {
  const modal = document.getElementById("approval-modal");
  modal.style.display = "flex";

  // Flight section
  if (approval.pending_bookings.flight) {
    const flight = approval.pending_bookings.flight;
    document.getElementById("flight-airline").textContent = flight.airline;
    document.getElementById("flight-price").textContent = `$${flight.price}`;
    document.getElementById("flight-dates").textContent =
      `${new Date(flight.departure).toLocaleDateString()} to ${new Date(flight.return).toLocaleDateString()}`;
    document.getElementById("flight-pros").innerHTML = flight.pros
      .map((p) => `<li>${p}</li>`)
      .join("");
    document.getElementById("flight-cons").innerHTML = flight.cons
      .map((c) => `<li>${c}</li>`)
      .join("");
    document.getElementById("flight-link").href = flight.url;
  }

  // Hotel section
  if (approval.pending_bookings.accommodation) {
    const hotel = approval.pending_bookings.accommodation;
    document.getElementById("hotel-name").textContent = hotel.name;
    document.getElementById("hotel-price").textContent = `$${hotel.price_per_night} /night`;
    document.getElementById("hotel-rating").textContent =
      `★ ${hotel.rating.toFixed(1)}`;

    const nights =
      (new Date(hotel.checkout).getTime() -
        new Date(hotel.checkin).getTime()) /
      (1000 * 60 * 60 * 24);
    document.getElementById("hotel-nights").textContent = `(${Math.ceil(nights)} nights)`;
    document.getElementById("hotel-dates").textContent =
      `${new Date(hotel.checkin).toLocaleDateString()} to ${new Date(hotel.checkout).toLocaleDateString()}`;

    document.getElementById("hotel-pros").innerHTML = hotel.pros
      .map((p) => `<li>${p}</li>`)
      .join("");
    document.getElementById("hotel-cons").innerHTML = hotel.cons
      .map((c) => `<li>${c}</li>`)
      .join("");
    document.getElementById("hotel-link").href = hotel.url;
  }

  // Activities section
  if (approval.pending_bookings.activities && approval.pending_bookings.activities.length > 0) {
    const activities = approval.pending_bookings.activities;
    const activitiesList = document.getElementById("activities-list");
    activitiesList.innerHTML = activities
      .map(
        (act) => `
      <div class="activity-item">
        <h4>${act.title}</h4>
        <p class="price">$${act.price} | ★${act.rating.toFixed(1)}</p>
        <p class="pro">✓ ${act.pros.join(", ")}</p>
        <p class="con">✗ ${act.cons.join(", ")}</p>
        <a href="${act.url}" target="_blank">View Activity →</a>
      </div>
    `
      )
      .join("");

    document.getElementById("activity-count").textContent = `(${activities.length} recommended)`;
  }

  // Calculate total cost
  const totalCost =
    (approval.pending_bookings.flight?.price || 0) +
    (approval.pending_bookings.accommodation?.price_per_night || 0) *
      Math.ceil(
        (new Date(approval.pending_bookings.accommodation?.checkout || Date.now()).getTime() -
          new Date(approval.pending_bookings.accommodation?.checkin || Date.now()).getTime()) /
          (1000 * 60 * 60 * 24)
      ) +
    (approval.pending_bookings.activities?.reduce((sum, a) => sum + a.price, 0) || 0);

  document.getElementById("total-cost-amount").textContent = `$${totalCost.toFixed(2)}`;
}

async function approveAll() {
  const sessionId = getCurrentSessionId();

  const response = await fetch(
    `https://api.travellite.dev/session/${sessionId}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approved: true,
        category: "all",
        notes: "User approved all recommendations",
      }),
    }
  );

  const data = await response.json();

  // Close modal and show booking links
  document.getElementById("approval-modal").style.display = "none";
  displayBookingItinerary(data.approved_selections);
}

function approveCategory(category: "flight" | "accommodation" | "activities") {
  const sessionId = getCurrentSessionId();

  fetch(`https://api.travellite.dev/session/${sessionId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      approved: true,
      category,
      notes: `User approved ${category}`,
    }),
  }).then(() => {
    // Update UI to show category as approved
    const card = document.getElementById(`${category}-card`);
    card.classList.add("approved");
    card.querySelector(".approval-buttons").remove();
  });
}

function rejectCategory(category: string) {
  const sessionId = getCurrentSessionId();

  const notes = prompt(`Why not interested in ${category}?`, "");

  fetch(`https://api.travellite.dev/session/${sessionId}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      approved: false,
      category,
      notes,
    }),
  }).then((res) => res.json())
    .then((data) => {
      alert(`${category} rejected. ${data.suggestion}`);
      // Show "Adjust Search" button
    });
}

function adjustSearch() {
  // Allow user to change preferences and re-run search
  document.getElementById("approval-modal").style.display = "none";
  document.getElementById("input-form").style.display = "block";
}

function displayBookingItinerary(approvedSelections: ApprovalState["approved_selections"]) {
  const container = document.getElementById("itinerary");
  container.innerHTML = `
    <div class="itinerary-header">
      <h3>📋 Your Trip Itinerary</h3>
      <p>Click below to complete your bookings</p>
    </div>

    <div class="itinerary-items">
      ${
        approvedSelections.flight
          ? `
        <div class="itinerary-item">
          <span class="emoji">✈️</span>
          <div class="item-content">
            <h4>Flight</h4>
            <p>${approvedSelections.flight.summary}</p>
          </div>
          <a href="${approvedSelections.flight.url}" target="_blank" class="book-now-btn">
            Book →
          </a>
        </div>
      `
          : ""
      }

      ${
        approvedSelections.accommodation
          ? `
        <div class="itinerary-item">
          <span class="emoji">🏨</span>
          <div class="item-content">
            <h4>Hotel</h4>
            <p>${approvedSelections.accommodation.summary}</p>
          </div>
          <a href="${approvedSelections.accommodation.url}" target="_blank" class="book-now-btn">
            Book →
          </a>
        </div>
      `
          : ""
      }

      ${
        approvedSelections.activities && approvedSelections.activities.length > 0
          ? `
        <div class="itinerary-item">
          <span class="emoji">🎭</span>
          <div class="item-content">
            <h4>Activities (${approvedSelections.activities.length})</h4>
            ${approvedSelections.activities.map((a) => `<p><a href="${a.url}" target="_blank">${a.summary}</a></p>`).join("")}
          </div>
        </div>
      `
          : ""
      }
    </div>

    <div class="itinerary-footer">
      <p class="note">💡 All bookings are manual. Click links to complete on vendor websites.</p>
      <button onclick="startNewSearch()" class="new-search-btn">+ Plan Another Trip</button>
    </div>
  `;
}
```

---

## User Flow Diagram

```
User Interface
┌─────────────────────────────────────────┐
│  Travellite Extension                   │
├─────────────────────────────────────────┤
│                                         │
│  [Input Form]                           │
│  Destination: Paris                     │
│  Dates: Dec 1-7                         │
│  Budget: $3000                          │
│  Preferences: beach, museums            │
│                                         │
│  [Start Planning ▶]                     │
│                                         │
│  ↓ (Streaming: "Planning...")           │
│  ↓ (Streaming: "Fetching flights...")   │
│  ↓ (Streaming: "Analyzing options...")  │
│                                         │
│  [APPROVAL MODAL APPEARS]               │
│  ┌─────────────────────────────────┐   │
│  │ ✈️ Flight                        │   │
│  │ United • $450                   │   │
│  │ ✓ Direct flight, good timing    │   │
│  │ ✗ Higher price than alternatives│   │
│  │                                 │   │
│  │ [View Flight Details] ✓ Approve │   │
│  │                                 │   │
│  │ 🏨 Hotel                         │   │
│  │ Marriott • $150/night           │   │
│  │ ✓ Central location, 4.5★ rating │   │
│  │ ✗ Expensive breakfast           │   │
│  │                                 │   │
│  │ [View Hotel Details] ✓ Approve  │   │
│  │                                 │   │
│  │ [✓ APPROVE ALL & SHOW BOOKINGS]  │   │
│  │ [← Adjust Search]               │   │
│  └─────────────────────────────────┘   │
│                                         │
│  ↓ (User clicks "Approve All")          │
│                                         │
│  [ITINERARY PAGE]                       │
│  📋 Your Trip Summary                   │
│                                         │
│  ✈️ Flight                              │
│  United • $450                          │
│  [Book Flight →] ← Opens new tab        │
│                                         │
│  🏨 Hotel                               │
│  Marriott • $150/night                  │
│  [Book Hotel →]  ← Opens new tab        │
│                                         │
│  🎭 Activities (3)                      │
│  - Louvre Museum • $25 [Book →]         │
│  - Seine River Cruise • $35 [Book →]    │
│  - Arc de Triomphe • $18 [Book →]       │
│                                         │
│  💡 All bookings are manual.             │
│  Click links to complete on vendor      │
│  websites.                              │
│                                         │
│  [+ Plan Another Trip]                  │
│                                         │
└─────────────────────────────────────────┘
        ↕  (User opens new tab for each booking)

Amadeus / Kayak / Booking.com / TripAdvisor
┌──────────────────────────┐
│ Real booking websites    │
│ User completes payment   │
└──────────────────────────┘
```

---

## Approval Data Flow (Backend)

```
Reviewer Node
    ↓
Returns: top 3 flights, top 3 hotels, top activities
    ↓
Approval Node
    ↓
Extract top 1 from each category
Build ApprovalState
Broadcast to extension: "awaiting_approval"
    ↓
PAUSE GRAPH EXECUTION
    ↓
Extension shows modal
User reviews + clicks approve
    ↓
Extension sends: POST /session/{id}/approve
    ↓
Backend Approval Handler
    ↓
Mark ApprovalState as approved
Log approval decision
Broadcast to extension: "approval_confirmed"
    ↓
Extension shows itinerary with booking links
    ↓
User clicks booking links (opens external websites)
    ↓
(Graph execution paused; future phase: continue for multi-leg trips)
```

---

## Approval Audit Trail

```sql
-- Record every approval decision for compliance/analytics
CREATE TABLE approval_log (
  id UUID PRIMARY KEY,
  session_id UUID,
  user_id UUID,
  timestamp TIMESTAMP,
  action "approved" | "rejected",
  category "flight" | "accommodation" | "activities",
  approved_options JSONB, -- What was shown to user
  user_notes TEXT,
  duration_seconds INT -- How long user deliberated
);

-- Example query: User approval rate per category
SELECT 
  category,
  COUNT(*) as total_approvals,
  COUNT(*) FILTER (WHERE action = 'approved') as approved_count,
  ROUND(
    COUNT(*) FILTER (WHERE action = 'approved') * 100.0 / COUNT(*),
    2
  ) as approval_rate
FROM approval_log
GROUP BY category
ORDER BY approval_rate DESC;
```

---

## FAQ

**Q: Why require approval for all bookings?**
A: MVP safety. Users see the agent's reasoning (pros/cons). Later, you can skip approvals for low-cost items (<$100).

**Q: Can user adjust recommendations?**
A: In MVP, only via "Adjust Search" (change dates/budget). Future: "Show me cheaper alternatives" → triggers Executor again.

**Q: What if user approves but doesn't book?**
A: Data is saved to IndexedDB. User can return to extension > "View My Trips" > Find that session > Retry booking links.

**Q: Does agent track if user actually completed booking?**
A: Not in MVP. User manually books. Phase 2: Optional: webhook from booking sites to confirm.

