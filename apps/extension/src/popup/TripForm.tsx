import {
  AIRPORTS,
  CITIES,
  IATA,
  MAX_BUDGET_USD,
  MAX_TRAVELERS,
  MIN_BUDGET_USD,
  parseVacationConfig,
  Preference,
  type PrefetchRequest,
  type VacationConfig,
} from "@travellite/schema";
import { useEffect, useId, useMemo, useRef, useState } from "react";

/** The form as typed: strings until validated. Saved to chrome.storage.local on every change. */
export interface Draft {
  origin: string;
  destination: string;
  departure_date: string;
  return_date: string;
  date_flex_days: 0 | 1 | 2;
  budget_usd: string;
  travelers: string;
  preferences: Preference[];
}

export const DRAFT_KEY = "draft";
export const PREFETCH_DEBOUNCE_MS = 800;

export const emptyDraft = (): Draft => ({
  origin: "",
  destination: "",
  departure_date: "",
  return_date: "",
  date_flex_days: 0,
  budget_usd: "",
  travelers: "2",
  preferences: [],
});

const PREFERENCE_LABELS: Record<Preference, string> = {
  beach: "Beach",
  museums: "Museums",
  food: "Food",
  nightlife: "Nightlife",
  outdoors: "Outdoors",
  shopping: "Shopping",
  family: "Family",
  relaxed_pace: "Relaxed pace",
};

type FieldErrors = Partial<Record<keyof Draft, string>>;

const toNumber = (s: string) => (s.trim() === "" ? NaN : Number(s));

/** Validates with the same schema the API uses. Returns the config or per-field errors. */
export function validateDraft(
  d: Draft,
  now = new Date(),
): { config?: VacationConfig; errors: FieldErrors } {
  const parsed = parseVacationConfig(
    {
      ...d,
      origin: d.origin.trim().toUpperCase(),
      budget_usd: toNumber(d.budget_usd),
      travelers: toNumber(d.travelers),
    },
    now,
  );
  if (parsed.success) return { config: parsed.data, errors: {} };
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] as keyof Draft | undefined;
    if (!field) continue;
    // Date-order rules ("Return must be after departure") are already written for people.
    const custom = issue.code === "custom";
    if (!errors[field] || custom)
      errors[field] = custom ? issue.message : (MESSAGES[field] ?? issue.message);
  }
  return { errors };
}

const MESSAGES: FieldErrors = {
  origin: "Enter a 3-letter airport code, e.g. JFK",
  destination: "Choose a destination",
  departure_date: "Choose a departure date",
  return_date: "Choose a return date",
  budget_usd: `Enter a budget from $${MIN_BUDGET_USD} to $${MAX_BUDGET_USD.toLocaleString("en-US")}`,
  travelers: `1 to ${MAX_TRAVELERS} travelers`,
};

/** The prefetch request once origin, destination, dates and travelers are valid. */
export function prefetchRequest(d: Draft, now = new Date()): PrefetchRequest | null {
  const { errors } = validateDraft(d, now);
  const blocking: (keyof Draft)[] = [
    "origin",
    "destination",
    "departure_date",
    "return_date",
    "travelers",
  ];
  if (blocking.some((f) => errors[f])) return null;
  const origin = d.origin.trim().toUpperCase();
  if (!IATA.safeParse(origin).success || !d.departure_date || !d.return_date) return null;
  return {
    origin,
    destination: d.destination,
    departure_date: d.departure_date,
    return_date: d.return_date,
    date_flex_days: d.date_flex_days,
    travelers: Number(d.travelers),
  };
}

export interface TripFormProps {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSubmit: (config: VacationConfig) => Promise<void> | void;
  onPrefetch: (req: PrefetchRequest) => void;
  /** Shown above the submit button, e.g. a failed session start. */
  error?: string | null;
  now?: () => Date;
}

export function TripForm({
  draft,
  onChange,
  onSubmit,
  onPrefetch,
  error,
  now = () => new Date(),
}: TripFormProps) {
  const id = useId();
  const [touched, setTouched] = useState<Partial<Record<keyof Draft, boolean>>>({});
  const [submitting, setSubmitting] = useState(false);
  const { config, errors } = useMemo(() => validateDraft(draft, now()), [draft, now]);
  const today = now().toISOString().slice(0, 10);

  // Debounced prefetch: warms the API's caches while the user is still typing.
  const prefetch = useMemo(() => prefetchRequest(draft, now()), [draft, now]);
  const prefetchKey = prefetch ? JSON.stringify(prefetch) : null;
  const onPrefetchRef = useRef(onPrefetch);
  onPrefetchRef.current = onPrefetch;
  useEffect(() => {
    if (!prefetchKey) return;
    const t = setTimeout(
      () => onPrefetchRef.current(JSON.parse(prefetchKey) as PrefetchRequest),
      PREFETCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [prefetchKey]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value });
  const touch = (key: keyof Draft) => setTouched((t) => (t[key] ? t : { ...t, [key]: true }));
  const shown = (key: keyof Draft) => (touched[key] ? errors[key] : undefined);
  const fieldId = (key: string) => `${id}-${key}`;
  const describedBy = (key: keyof Draft) => (shown(key) ? `${fieldId(key)}-error` : undefined);

  const fieldError = (key: keyof Draft) =>
    shown(key) ? (
      <p className="field-error" id={`${fieldId(key)}-error`}>
        {shown(key)}
      </p>
    ) : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(Object.fromEntries(Object.keys(draft).map((k) => [k, true])));
    if (!config || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(config);
    } finally {
      setSubmitting(false);
    }
  }

  const togglePreference = (p: Preference) =>
    set(
      "preferences",
      draft.preferences.includes(p)
        ? draft.preferences.filter((x) => x !== p)
        : [...draft.preferences, p],
    );

  return (
    <form className="trip-form" onSubmit={submit} noValidate aria-label="Plan a trip">
      <div className="row">
        <div className="field">
          <label htmlFor={fieldId("origin")}>From</label>
          <input
            id={fieldId("origin")}
            list={fieldId("airports")}
            value={draft.origin}
            onChange={(e) => set("origin", e.target.value.toUpperCase().slice(0, 3))}
            onBlur={() => touch("origin")}
            placeholder="JFK"
            autoComplete="off"
            maxLength={3}
            aria-invalid={!!shown("origin")}
            aria-describedby={describedBy("origin")}
          />
          <datalist id={fieldId("airports")}>
            {AIRPORTS.map((a) => (
              <option key={a.code} value={a.code}>
                {a.city}
              </option>
            ))}
          </datalist>
          {fieldError("origin")}
        </div>
        <div className="field">
          <label htmlFor={fieldId("destination")}>To</label>
          <select
            id={fieldId("destination")}
            value={draft.destination}
            onChange={(e) => set("destination", e.target.value)}
            onBlur={() => touch("destination")}
            aria-invalid={!!shown("destination")}
            aria-describedby={describedBy("destination")}
          >
            <option value="">Choose…</option>
            {CITIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {fieldError("destination")}
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor={fieldId("departure_date")}>Depart</label>
          <input
            id={fieldId("departure_date")}
            type="date"
            min={today}
            value={draft.departure_date}
            onChange={(e) => set("departure_date", e.target.value)}
            onBlur={() => touch("departure_date")}
            aria-invalid={!!shown("departure_date")}
            aria-describedby={describedBy("departure_date")}
          />
          {fieldError("departure_date")}
        </div>
        <div className="field">
          <label htmlFor={fieldId("return_date")}>Return</label>
          <input
            id={fieldId("return_date")}
            type="date"
            min={draft.departure_date || today}
            value={draft.return_date}
            onChange={(e) => set("return_date", e.target.value)}
            onBlur={() => touch("return_date")}
            aria-invalid={!!shown("return_date")}
            aria-describedby={describedBy("return_date")}
          />
          {fieldError("return_date")}
        </div>
      </div>

      <fieldset className="flex">
        <legend>Flexible dates</legend>
        {([0, 1, 2] as const).map((n) => (
          <label key={n} className="radio">
            <input
              type="radio"
              name={fieldId("flex")}
              checked={draft.date_flex_days === n}
              onChange={() => set("date_flex_days", n)}
            />
            {n === 0 ? "Exact" : `± ${n} day${n > 1 ? "s" : ""}`}
          </label>
        ))}
      </fieldset>

      <div className="row">
        <div className="field">
          <label htmlFor={fieldId("budget_usd")}>Total budget (USD)</label>
          <input
            id={fieldId("budget_usd")}
            inputMode="numeric"
            value={draft.budget_usd}
            onChange={(e) => set("budget_usd", e.target.value.replace(/[^\d]/g, ""))}
            onBlur={() => touch("budget_usd")}
            placeholder="4000"
            aria-invalid={!!shown("budget_usd")}
            aria-describedby={describedBy("budget_usd")}
          />
          {fieldError("budget_usd")}
        </div>
        <div className="field narrow">
          <label htmlFor={fieldId("travelers")}>Travelers</label>
          <input
            id={fieldId("travelers")}
            type="number"
            min={1}
            max={MAX_TRAVELERS}
            value={draft.travelers}
            onChange={(e) => set("travelers", e.target.value)}
            onBlur={() => touch("travelers")}
            aria-invalid={!!shown("travelers")}
            aria-describedby={describedBy("travelers")}
          />
          {fieldError("travelers")}
        </div>
      </div>

      <fieldset className="prefs">
        <legend>Interests</legend>
        <div className="chips">
          {Preference.options.map((p) => (
            <button
              key={p}
              type="button"
              className="chip"
              aria-pressed={draft.preferences.includes(p)}
              onClick={() => togglePreference(p)}
            >
              {PREFERENCE_LABELS[p]}
            </button>
          ))}
        </div>
      </fieldset>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary" disabled={!config || submitting}>
        {submitting ? "Starting…" : "Plan my trip"}
      </button>
    </form>
  );
}
