import { isAllowedBookingUrl, type SavedItinerary } from "@travellite/schema";
import { useCallback, useEffect, useState } from "react";
import type { TripsDb } from "../worker/trips-db.js";
import { LABELS, cityName, money, shortDate } from "./format.js";

type Link = SavedItinerary["selections"]["flight"];

/** A booking link, opened in a new tab. Anything off the allowlist renders as plain text. */
function BookingLink({
  link,
  label,
  openTab,
}: {
  link: Link;
  label: string;
  openTab: (url: string) => void;
}) {
  if (!isAllowedBookingUrl(link.url)) {
    return (
      <p>
        <span className="muted">{label}:</span> {link.summary}
      </p>
    );
  }
  return (
    <p>
      <span className="muted">{label}:</span>{" "}
      <a
        href={link.url}
        onClick={(e) => {
          e.preventDefault();
          openTab(link.url);
        }}
      >
        {link.summary}
      </a>
    </p>
  );
}

export interface MyTripsProps {
  db: TripsDb;
  /** Opened right after a selection. */
  initialId?: string | null;
  openTab?: (url: string) => void;
  onPlanAnother: () => void;
}

export function MyTrips({
  db,
  initialId = null,
  openTab = (url) => void chrome.tabs.create({ url }),
  onPlanAnother,
}: MyTripsProps) {
  const [trips, setTrips] = useState<SavedItinerary[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialId);
  const reload = useCallback(() => db.list().then(setTrips), [db]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => setOpenId(initialId), [initialId]);

  if (trips === null) return <p className="muted">Loading…</p>;

  const open = trips.find((t) => t.session_id === openId);
  if (open) {
    return (
      <section className="trip-detail" aria-label="Saved trip">
        <button type="button" className="link" onClick={() => setOpenId(null)}>
          ← All trips
        </button>
        <h2>{cityName(open.destination)}</h2>
        <p className="muted">
          {shortDate(open.dates.departure)} – {shortDate(open.dates.return)} ·{" "}
          {LABELS[open.package_label]} · {money(open.total_usd)}
        </p>
        <p className={`status-pill ${open.status}`}>
          {open.status === "booked" ? "Booked" : "Not booked yet"}
        </p>
        <BookingLink link={open.selections.flight} label="Flight" openTab={openTab} />
        <BookingLink link={open.selections.hotel} label="Hotel" openTab={openTab} />
        {open.selections.activities.map((a, i) => (
          <BookingLink key={i} link={a} label="Activity" openTab={openTab} />
        ))}
        <p className="muted small">
          Book each part yourself; Travellite never books or takes payment.
        </p>
        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              await db.setStatus(open.session_id, open.status === "booked" ? "saved" : "booked");
              await reload();
            }}
          >
            {open.status === "booked" ? "Mark as not booked" : "Mark as booked"}
          </button>
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (!confirm("Delete this trip?")) return;
              await db.delete(open.session_id);
              setOpenId(null);
              await reload();
            }}
          >
            Delete
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="my-trips" aria-label="My trips">
      {trips.length === 0 ? (
        <p className="muted">No saved trips yet. Choose a package to save it here.</p>
      ) : (
        <ul className="trip-list">
          {trips.map((t) => (
            <li key={t.session_id}>
              <button type="button" className="trip-row" onClick={() => setOpenId(t.session_id)}>
                <span>
                  <strong>{cityName(t.destination)}</strong>
                  <span className="muted">
                    {" "}
                    {shortDate(t.dates.departure)} – {shortDate(t.dates.return)}
                  </span>
                </span>
                <span>
                  {money(t.total_usd)}
                  {t.status === "booked" && <span className="status-pill booked"> Booked</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="primary" onClick={onPlanAnother}>
        Plan another trip
      </button>
    </section>
  );
}
