import type { PrefetchRequest, RefineRequest, VacationConfig } from "@travellite/schema";
import { useEffect, useMemo, useState } from "react";
import type { TripState } from "../worker/trip-state.js";
import { TRIP_KEY } from "../worker/controller.js";
import { createTripsDb, type TripsDb } from "../worker/trips-db.js";
import { send, useStored } from "./ext.js";
import { MyTrips } from "./MyTrips.js";
import { PackagesView } from "./PackagesView.js";
import { RefineBar } from "./RefineBar.js";
import { DRAFT_KEY, TripForm, emptyDraft, type Draft } from "./TripForm.js";

type Tab = "plan" | "trips";

export interface AppProps {
  db?: TripsDb;
}

export function App({ db: injectedDb }: AppProps = {}) {
  const db = useMemo(() => injectedDb ?? createTripsDb(), [injectedDb]);
  const trip = useStored<TripState>("session", TRIP_KEY);
  const storedDraft = useStored<Draft>("local", DRAFT_KEY);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<Tab>("plan");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);

  // Registers on first run and lets the worker resume an unfinished trip.
  useEffect(() => {
    send({ type: "status" }).then(
      (res) => setConnectError(res.registered ? null : (res.error ?? "Couldn't reach Travellite.")),
      () => setConnectError("The extension's background service isn't running. Reopen the popup."),
    );
  }, []);

  // The draft is restored once, then owned by this component and saved on every change.
  useEffect(() => {
    if (draft === null && storedDraft !== undefined)
      setDraft({ ...emptyDraft(), ...(storedDraft ?? {}) });
  }, [draft, storedDraft]);

  const updateDraft = (d: Draft) => {
    setDraft(d);
    void chrome.storage.local.set({ [DRAFT_KEY]: d });
  };

  async function start(config: VacationConfig) {
    setFormError(null);
    setSelectError(null);
    const res = await send({ type: "start", config });
    if (!res.ok) setFormError(res.error.message);
  }

  async function refine(body: RefineRequest): Promise<string | null> {
    const res = await send({ type: "refine", body });
    return res.ok ? null : res.error.message;
  }

  async function select(packageId: string) {
    setSelecting(packageId);
    setSelectError(null);
    try {
      const res = await send({ type: "select", package_id: packageId });
      if (!res.ok) {
        setSelectError(res.error.message);
        return;
      }
      setSavedId(res.value.session_id);
      setTab("trips");
    } finally {
      setSelecting(null);
    }
  }

  async function editTrip() {
    if (trip && trip.packages.length > 0 && !confirm("Discard these packages and edit the trip?"))
      return;
    await send({ type: "reset" });
  }

  async function planAnother() {
    await send({ type: "reset" });
    updateDraft(emptyDraft());
    setSavedId(null);
    setTab("plan");
  }

  const loading = trip === undefined || draft === null;

  return (
    <main className="app">
      <header className="app-head">
        <h1>Travellite</h1>
        <nav className="tabs" aria-label="Sections">
          <button
            type="button"
            aria-current={tab === "plan" ? "page" : undefined}
            onClick={() => setTab("plan")}
          >
            Plan
          </button>
          <button
            type="button"
            aria-current={tab === "trips" ? "page" : undefined}
            onClick={() => setTab("trips")}
          >
            My trips
          </button>
        </nav>
      </header>

      {connectError && (
        <p className="banner error" role="alert">
          {connectError}
        </p>
      )}

      {tab === "trips" ? (
        <MyTrips db={db} initialId={savedId} onPlanAnother={() => void planAnother()} />
      ) : loading ? (
        <p className="muted">Loading…</p>
      ) : trip ? (
        <>
          {selectError && (
            <p className="banner error" role="alert">
              {selectError}
            </p>
          )}
          <PackagesView
            trip={trip}
            selecting={selecting}
            onSelect={(id) => void select(id)}
            onRetry={() => void start({ ...trip.config, ...trip.current })}
            onEdit={() => void editTrip()}
          />
          {/* After a failure no refinement can fix, chips would only be rejected. */}
          {!(trip.phase === "error" && !trip.error?.refinable) && (
            <RefineBar trip={trip} onRefine={refine} />
          )}
        </>
      ) : (
        <TripForm
          draft={draft}
          onChange={updateDraft}
          onSubmit={start}
          onPrefetch={(req: PrefetchRequest) => void send({ type: "prefetch", req })}
          error={formError}
        />
      )}
    </main>
  );
}
