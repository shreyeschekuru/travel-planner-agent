import type { OptionCategory, PackageExplanation, TripPackage } from "@travellite/schema";
import { affectedParts, type TripState } from "../worker/trip-state.js";
import {
  CATEGORY_NAMES,
  LABELS,
  cityName,
  duration,
  localTime,
  money,
  shortDate,
  stops,
} from "./format.js";

const DEGRADED_NOTE: Record<OptionCategory, string> = {
  flight: "Flight prices couldn't be loaded.",
  hotel: "Hotel prices couldn't be loaded.",
  activity: "Activities couldn't be loaded, so packages don't include them.",
};

function statusLine(s: TripState): string {
  if (s.phase === "searching") {
    const done = (["flight", "hotel", "activity"] as const).filter((c) => s.results[c]);
    return done.length === 0
      ? "Searching flights, hotels and activities…"
      : `Found ${done.map((c) => CATEGORY_NAMES[c].toLowerCase()).join(", ")}. Building packages…`;
  }
  if (s.phase === "explaining") return "Packages ready. Writing summaries…";
  if (s.phase === "refining")
    return s.refinements.pending ? `Updating: ${s.refinements.pending.reason}` : "Updating…";
  if (s.connection === "reconnecting") return "Reconnecting…";
  return "";
}

function Explanation({ e }: { e: PackageExplanation | undefined }) {
  if (!e) {
    return (
      <p className="explain pending" aria-busy="true">
        Writing a summary…
      </p>
    );
  }
  return (
    <div className="explain">
      <p className="headline">{e.headline}</p>
      <ul className="pros" aria-label="Pros">
        {e.pros.map((c, i) => (
          <li key={i}>{c.text}</li>
        ))}
      </ul>
      <ul className="cons" aria-label="Trade-offs">
        {e.cons.map((c, i) => (
          <li key={i}>{c.text}</li>
        ))}
      </ul>
    </div>
  );
}

interface CardProps {
  pkg: TripPackage;
  explanation: PackageExplanation | undefined;
  budget: number;
  updating: Set<string>;
  canSelect: boolean;
  onSelect: (id: string) => void;
  selecting: boolean;
}

function PackageCard({
  pkg,
  explanation,
  budget,
  updating,
  canSelect,
  onSelect,
  selecting,
}: CardProps) {
  const f = pkg.flight;
  const h = pkg.hotel;
  const shownActivities = pkg.activities.slice(0, 3);
  const section = (part: string) => ({
    className: `part${updating.has(part) ? " updating" : ""}`,
    "aria-busy": updating.has(part) || undefined,
  });
  return (
    <article className="card" aria-labelledby={`${pkg.id}-label`}>
      <header className="card-head">
        <span className={`badge ${pkg.label}`} id={`${pkg.id}-label`}>
          {LABELS[pkg.label]}
        </span>
        <div {...section("total")}>
          <span className="total">{money(pkg.total_usd)}</span>
          <span className="muted"> of {money(budget)}</span>
        </div>
      </header>

      <div {...section("flight")}>
        <h3>Flight</h3>
        <p>{f.title}</p>
        <p className="muted">
          {localTime(f.attrs.depart_at)} → {localTime(f.attrs.arrive_at)} · {stops(f.attrs.stops)} ·{" "}
          {duration(f.attrs.duration_min)}
        </p>
      </div>

      <div {...section("hotel")}>
        <h3>Hotel</h3>
        <p>{h.title}</p>
        <p className="muted">
          {h.rating !== undefined && <>★ {h.rating.toFixed(1)} · </>}
          {h.attrs.nights} night{h.attrs.nights > 1 ? "s" : ""}
          {h.attrs.km_from_center !== undefined && (
            <> · {h.attrs.km_from_center.toFixed(1)} km from center</>
          )}
        </p>
      </div>

      <div {...section("activities")}>
        <h3>Activities</h3>
        {pkg.activities.length === 0 ? (
          <p className="muted">None included</p>
        ) : (
          <ul className="activities">
            {shownActivities.map((a) => (
              <li key={a.id}>{a.title}</li>
            ))}
            {pkg.activities.length > shownActivities.length && (
              <li className="muted">and {pkg.activities.length - shownActivities.length} more</li>
            )}
          </ul>
        )}
      </div>

      <Explanation e={explanation} />

      <button
        type="button"
        className="primary"
        disabled={!canSelect || selecting}
        onClick={() => onSelect(pkg.id)}
        aria-describedby={`${pkg.id}-label`}
      >
        {selecting ? "Saving…" : "Choose this trip"}
      </button>
    </article>
  );
}

export interface PackagesViewProps {
  trip: TripState;
  onSelect: (packageId: string) => void;
  selecting: string | null;
  onRetry: () => void;
  onEdit: () => void;
}

export function PackagesView({ trip, onSelect, selecting, onRetry, onEdit }: PackagesViewProps) {
  const c = { ...trip.config, ...trip.current };
  const updating =
    trip.phase === "refining" ? affectedParts(trip.refinements.pending) : new Set<string>();
  const degraded = (
    Object.entries(trip.results) as [OptionCategory, TripState["results"][OptionCategory]][]
  ).filter(([, r]) => r && "degraded" in r);
  const status = statusLine(trip);

  return (
    <section className="packages" aria-label="Trip packages">
      <header className="trip-summary">
        <div>
          <h2>
            {c.origin} → {cityName(c.destination)}
          </h2>
          <p className="muted">
            {shortDate(c.departure_date)} – {shortDate(c.return_date)} · {c.travelers} traveler
            {c.travelers > 1 ? "s" : ""} · {money(c.budget_usd)}
          </p>
        </div>
        <button type="button" className="link" onClick={onEdit}>
          Edit trip
        </button>
      </header>

      <p className="status" role="status" aria-live="polite">
        {status}
      </p>

      {degraded.map(([category]) => (
        <p key={category} className="banner warn">
          {DEGRADED_NOTE[category]}
        </p>
      ))}

      {trip.phase === "error" && trip.error && (
        <div className="banner error" role="alert">
          <p>{trip.error.message}</p>
          <div className="actions">
            {(trip.error.retryable || trip.error.code === "SESSION_EXPIRED") && (
              <button type="button" onClick={onRetry}>
                {trip.error.code === "SESSION_EXPIRED" ? "Plan again" : "Try again"}
              </button>
            )}
            <button type="button" className="link" onClick={onEdit}>
              Change trip
            </button>
          </div>
        </div>
      )}

      {trip.phase === "advice" && trip.budget_advice && (
        <div className="banner advice" role="status">
          <p>
            <strong>Nothing fits {money(c.budget_usd)}.</strong> The cheapest trip is{" "}
            {money(trip.budget_advice.cheapest_total_usd)}, mostly the{" "}
            {trip.budget_advice.driver === "activities" ? "activities" : trip.budget_advice.driver}.
          </p>
          {trip.budget_advice.nearest_fitting_dates && (
            <p>
              {shortDate(trip.budget_advice.nearest_fitting_dates.depart)} –{" "}
              {shortDate(trip.budget_advice.nearest_fitting_dates.return)} would fit at{" "}
              {money(trip.budget_advice.nearest_fitting_dates.total_usd)}.
            </p>
          )}
          <p className="muted">Try a refinement below, or raise your budget.</p>
        </div>
      )}

      {trip.phase === "searching" && trip.packages.length === 0 && (
        <div className="skeletons" aria-hidden="true">
          <div className="card skeleton" />
          <div className="card skeleton" />
        </div>
      )}

      {trip.packages.map((pkg) => (
        <PackageCard
          key={pkg.id}
          pkg={pkg}
          explanation={trip.explanations[pkg.id]}
          budget={c.budget_usd}
          updating={updating}
          canSelect={trip.phase === "ready"}
          onSelect={onSelect}
          selecting={selecting === pkg.id}
        />
      ))}
    </section>
  );
}
