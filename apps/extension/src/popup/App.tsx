import { useEffect, useState } from "react";
import type { WorkerRequest, WorkerResponse } from "../worker/messages.js";

type State = { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const req: WorkerRequest = { type: "status" };
    chrome.runtime.sendMessage(req).then(
      (res: WorkerResponse) =>
        setState(
          res.registered ? { kind: "ready" } : { kind: "error", message: res.error ?? "Error" },
        ),
      () => setState({ kind: "error", message: "Extension background isn't running." }),
    );
  }, []);

  return (
    <main style={{ width: 360, padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Travellite</h1>
      {state.kind === "loading" && <p>Connecting…</p>}
      {state.kind === "ready" && <p>Ready. Trip planning arrives in a later milestone.</p>}
      {state.kind === "error" && <p role="alert">{state.message}</p>}
    </main>
  );
}
