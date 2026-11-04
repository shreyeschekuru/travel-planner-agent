import {
  MAX_REFINE_TEXT,
  MAX_REFINEMENTS,
  RefineChip,
  type RefineRequest,
} from "@travellite/schema";
import { useId, useState } from "react";
import { canRefine, type TripState } from "../worker/trip-state.js";

export const CHIP_LABELS: Record<RefineChip, string> = {
  cheaper_hotel: "Cheaper hotel",
  better_hotel: "Better hotel",
  fewer_stops: "Fewer stops",
  shift_dates_earlier: "A day earlier",
  shift_dates_later: "A day later",
  more_activities: "More activities",
};

export interface RefineBarProps {
  trip: TripState;
  /** Resolves with an error message when the API refused the refinement. */
  onRefine: (body: RefineRequest) => Promise<string | null>;
}

export function RefineBar({ trip, onRefine }: RefineBarProps) {
  const id = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const used = trip.refinements.count;
  const exhausted = used >= MAX_REFINEMENTS;
  const disabled = busy || !canRefine(trip);
  const last = trip.refinements.last;

  async function submit(body: RefineRequest) {
    setBusy(true);
    setError(null);
    try {
      const err = await onRefine(body);
      if (err) setError(err);
      else if ("text" in body) setText("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="refine" aria-label="Refine this trip">
      <div className="chips" role="group" aria-label="Quick changes">
        {RefineChip.options.map((chip) => (
          <button
            key={chip}
            type="button"
            className="chip"
            disabled={disabled}
            onClick={() => void submit({ chip })}
          >
            {CHIP_LABELS[chip]}
          </button>
        ))}
      </div>
      <form
        className="refine-text"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void submit({ text: text.trim() });
        }}
      >
        <label htmlFor={`${id}-text`} className="visually-hidden">
          Describe a change
        </label>
        <input
          id={`${id}-text`}
          value={text}
          maxLength={MAX_REFINE_TEXT}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. hotels under $150 a night"
          disabled={disabled}
          aria-describedby={`${id}-count`}
        />
        <button type="submit" disabled={disabled || !text.trim()}>
          Apply
        </button>
      </form>
      <p className="muted small" id={`${id}-count`}>
        {text.length}/{MAX_REFINE_TEXT} ·{" "}
        {exhausted
          ? `You've used all ${MAX_REFINEMENTS} refinements`
          : `${used} of ${MAX_REFINEMENTS} refinements used`}
      </p>
      <div role="status" aria-live="polite">
        {error ? (
          <p className="field-error">{error}</p>
        ) : last ? (
          <p className={last.changed ? "applied" : "muted"}>
            {last.changed ? last.reason : `No change: ${last.reason}`}
          </p>
        ) : null}
      </div>
    </section>
  );
}
