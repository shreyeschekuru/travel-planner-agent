import { randomUUID } from "node:crypto";
import {
  cityById,
  type ActivityOption,
  type ErrorCode,
  type FlightOption,
  type HotelOption,
  type Option,
  type OptionCategory,
  type PackageExplanation,
  type SessionEvent,
  type SessionRecord,
  type TripPackage,
} from "@travellite/schema";
import { traceable } from "langsmith/traceable";
import { budgetAdvice } from "../core/budget-advice.js";
import {
  noFlights,
  noHotels,
  noMatchingDates,
  providerFailure,
  type Diagnosis,
  type TripContext,
} from "../core/diagnose.js";
import { invalidated } from "../core/deltas.js";
import { optimize } from "../core/optimizer.js";
import type { LlmClient } from "../llm/client.js";
import { explainPackages } from "../llm/explain.js";
import type { ProviderError } from "../providers/provider.js";
import type { CategoryResult, SearchRequest, SearchService } from "../search/search.js";
import type { Cache } from "../store/cache.js";
import type { EventStore } from "../store/events.js";
import { keys } from "../store/keys.js";
import type { RedisClient } from "../store/redis.js";
import type { SessionStore } from "../store/sessions.js";

/** How far around the requested dates budget advice looks in the cache for a fitting pair. */
export const ADVICE_WINDOW_DAYS = 3;
const LOCK_TTL_MS = 120_000;

export interface RunnerDeps {
  redis: RedisClient;
  sessions: SessionStore;
  events: EventStore;
  search: SearchService;
  llm: LlmClient;
  cache: Cache;
  now?: () => Date;
  log?: (err: unknown, msg: string) => void;
  /** Recoverable problems worth a look, such as a provider refusing a search. */
  warn?: (data: Record<string, unknown>, msg: string) => void;
}

/** Identity of an event for de-duplication when a run is repeated after a restart. */
function eventKey(e: SessionEvent): string {
  switch (e.event) {
    case "results":
    case "degraded":
      return `${e.event}:${e.data.category}`;
    case "explanation":
      return `explanation:${e.data.package_id}`;
    default:
      return e.event;
  }
}

const RELEASE_LOCK = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`;

export function searchRequest(s: SessionRecord): SearchRequest {
  return {
    origin: s.config.origin,
    destination: s.config.destination,
    depart: s.constraints.dates.depart,
    return: s.constraints.dates.return,
    flex_days: s.constraints.dates.flex_days,
    travelers: s.constraints.travelers,
  };
}

/**
 * Runs a session through design.md §3 steps 1–5. Every event goes to the session's Redis
 * stream. A run holds a lock so only one instance works on a session; a repeated run (after a
 * restart) skips events already in the stream and reuses packages already sent.
 */
export class SessionRunner {
  private readonly running = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  private readonly log: (err: unknown, msg: string) => void;
  private readonly warn: (data: Record<string, unknown>, msg: string) => void;

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? ((err, msg) => console.error(msg, err));
    this.warn = deps.warn ?? ((data, msg) => console.warn(msg, data));
  }

  /** Starts a run in the background unless this instance already has one for the session. */
  start(id: string): void {
    if (this.running.has(id)) return;
    const p = this.run(id)
      .catch((err: unknown) => this.log(err, "session run failed"))
      .finally(() => this.running.delete(id));
    this.running.set(id, p);
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  /** Restarts sessions left in "searching" by an instance that stopped mid-run. */
  async recover(): Promise<number> {
    let started = 0;
    let cursor = "0";
    do {
      const [next, found] = await this.deps.redis.scan(
        cursor,
        "MATCH",
        keys.session("*"),
        "COUNT",
        200,
      );
      cursor = next;
      for (const key of found) {
        const id = key.slice(keys.session("").length);
        const s = await this.deps.sessions.get(id);
        if (s?.status === "searching" || s?.status === "refining") {
          this.start(id);
          started++;
        }
      }
    } while (cursor !== "0");
    return started;
  }

  async run(id: string): Promise<void> {
    const token = randomUUID();
    const lockKey = keys.runLock(id);
    const locked = await this.deps.redis.set(lockKey, token, "PX", LOCK_TTL_MS, "NX");
    if (!locked) return; // another instance is running it
    try {
      const session = await this.deps.sessions.get(id);
      if (!session || (session.status !== "searching" && session.status !== "refining")) return;
      // Only the session ID is traced; places and dates stay out of spans (design.md §9).
      await traceable((_span: { session: string }) => this.steps(session), {
        name: "session",
        run_type: "chain",
      })({ session: id });
    } catch (err) {
      await this.fail(id, "UNKNOWN_ERROR", "Something went wrong planning this trip", true).catch(
        () => {},
      );
      throw err;
    } finally {
      await this.deps.redis.eval(RELEASE_LOCK, 1, lockKey, token);
    }
  }

  private async steps(initial: SessionRecord): Promise<void> {
    let session = initial;
    const { events, sessions } = this.deps;
    // A refinement starts a new round at its refine_applied event; only this round's events
    // count when skipping work a previous run already did.
    const all = await events.readAfter(session.id, "0", 1000);
    const roundStart = all.findLastIndex((p) => p.event.event === "refine_applied");
    const prior = all.slice(roundStart + 1);
    const previous = new Map(session.packages.map((p) => [p.id, p] as const));
    const previousExplanations = new Map(
      session.explanations.map((e) => [e.package_id, e] as const),
    );
    const sent = new Set(prior.map((p) => eventKey(p.event)));
    const emit = async (e: SessionEvent) => {
      const k = eventKey(e);
      if (sent.has(k)) return;
      sent.add(k);
      await events.append(session.id, e);
    };
    const save = async (patch: Partial<SessionRecord>) => {
      session = { ...session, ...patch };
      await sessions.put(session);
    };

    if (sent.has("budget_advice") || sent.has("error")) {
      // A previous run finished this session except for its status.
      await save({ status: sent.has("error") ? "failed" : "awaiting_selection" });
      return;
    }
    const priorPackages = prior.find((p) => p.event.event === "packages")?.event;
    let packages: TripPackage[];

    if (priorPackages?.event === "packages") {
      packages = priorPackages.data;
    } else {
      // Steps 1–2 (constraints were built when the session was created): search.
      const req = searchRequest(session);
      const r =
        session.status === "refining"
          ? await this.refreshResults(session, req)
          : await this.deps.search.search(req);
      const fetched_at = this.now().toISOString();
      const categories: [OptionCategory, CategoryResult][] = [
        ["flight", r.flights],
        ["hotel", r.hotels],
        ["activity", r.activities],
      ];
      for (const [category, res] of categories) {
        await emit(
          res.ok
            ? { event: "results", data: { category, count: res.options.length } }
            : { event: "degraded", data: { category, error_kind: res.error.kind } },
        );
      }
      await save({
        results: Object.fromEntries(
          categories.map(([category, res]) => [
            category,
            {
              option_ids: res.ok ? res.options.map((o) => o.id) : [],
              fetched_at,
              degraded: !res.ok,
            },
          ]),
        ),
      });

      const city = cityById(session.config.destination)!;
      const trip: TripContext = {
        origin: session.config.origin,
        cityName: city.name,
        depart: req.depart,
        return: req.return,
        flexDays: req.flex_days,
        travelers: req.travelers,
      };
      // Provider details go to the logs; clients get a message naming the cause.
      for (const [category, res] of categories) {
        if (!res.ok)
          this.warn({ session: session.id, category, ...res.error }, "provider search failed");
      }
      // A package needs both a flight and a hotel.
      if (!r.flights.ok || !r.hotels.ok) {
        const [category, error] = !r.flights.ok
          ? (["flight", r.flights.error] as const)
          : (["hotel", (r.hotels as { error: ProviderError }).error] as const);
        await this.diagnosed(providerFailure(category, error.kind, trip), emit, save);
        return;
      }

      // Step 3: optimize.
      const input = {
        flights: r.flights.options,
        hotels: r.hotels.options,
        activities: r.activities.ok ? r.activities.options : [],
        cityCenter: city.center,
      };
      const result = optimize(input, session.constraints);
      if (result.kind === "no_options" || result.kind === "no_matching_dates") {
        const diagnosis =
          result.kind === "no_matching_dates"
            ? noMatchingDates(trip)
            : result.category === "flight"
              ? noFlights(input.flights, session.constraints, trip)
              : noHotels(input.hotels, session.constraints, trip);
        await this.diagnosed(diagnosis, emit, save);
        return;
      }
      if (result.kind === "over_budget") {
        const grid = await this.deps.search.cachedGrid(req, ADVICE_WINDOW_DAYS);
        await emit({
          event: "budget_advice",
          data: budgetAdvice(input, session.constraints, grid),
        });
        // Refinement (e.g. a higher budget) can still continue from here.
        await save({ status: "awaiting_selection", packages: [], explanations: [] });
        return;
      }
      packages = result.packages;
      // Explanations are saved with their packages at the end of the round.
      await save({ packages, explanations: [] });
      await emit({ event: "packages", data: packages });
    }

    // Step 4: explain. Reuse explanations this round already sent, and those of packages a
    // refinement left exactly as they were.
    const explained = new Map<string, PackageExplanation>();
    for (const p of prior)
      if (p.event.event === "explanation") explained.set(p.event.data.package_id, p.event.data);
    for (const p of packages) {
      const before = previous.get(p.id);
      const e = previousExplanations.get(p.id);
      if (!explained.has(p.id) && e && before && JSON.stringify(before) === JSON.stringify(p)) {
        explained.set(p.id, e);
        await emit({ event: "explanation", data: e });
      }
    }
    const missing = packages.filter((p) => !explained.has(p.id));
    if (missing.length) {
      await explainPackages(this.deps.llm, missing, session.constraints, async (e) => {
        explained.set(e.package_id, e);
        await emit({ event: "explanation", data: e });
      });
    }

    // Step 5.
    await save({
      packages,
      explanations: packages.flatMap((p) => explained.get(p.id) ?? []),
      status: "awaiting_selection",
    });
    await emit({ event: "awaiting_selection", data: {} });
  }

  /** Results after a refinement: invalidated categories re-searched, the rest from the option store. */
  private async refreshResults(session: SessionRecord, req: SearchRequest) {
    const delta = session.delta_history.at(-1);
    const redo = new Set(delta ? invalidated(delta) : (["flight", "hotel", "activity"] as const));
    const load = async <O extends Option>(category: OptionCategory): Promise<O[]> => {
      const ids = session.results[category]?.option_ids ?? [];
      const found = await this.deps.cache.getOptions(ids);
      // Expired or degraded results can't be reused.
      if (found.size < ids.length || session.results[category]?.degraded !== false)
        redo.add(category);
      return ids.flatMap((id) => (found.get(id) as O | undefined) ?? []);
    };
    const prior = {
      flights: await load<FlightOption>("flight"),
      hotels: await load<HotelOption>("hotel"),
      activities: await load<ActivityOption>("activity"),
    };
    return this.deps.search.refresh(req, prior, redo);
  }

  /**
   * Reports why no packages could be built. When a refinement can fix it, the session stays
   * open for one; otherwise it's marked failed.
   */
  private async diagnosed(
    d: Diagnosis,
    emit: (e: SessionEvent) => Promise<void>,
    save: (patch: Partial<SessionRecord>) => Promise<void>,
  ): Promise<void> {
    await emit({
      event: "error",
      data: {
        code: d.code,
        message: d.message,
        retryable: d.retryable,
        refinable: d.refinable,
        category: d.category,
      },
    });
    // Packages from an earlier round no longer match the constraints.
    await save({
      status: d.refinable ? "awaiting_selection" : "failed",
      packages: [],
      explanations: [],
    });
  }

  private async fail(
    id: string,
    code: ErrorCode,
    message: string,
    retryable: boolean,
    emit: (e: SessionEvent) => Promise<void> = (e) => this.deps.events.append(id, e).then(() => {}),
  ): Promise<void> {
    await emit({ event: "error", data: { code, message, retryable } });
    const s = await this.deps.sessions.get(id);
    if (s) await this.deps.sessions.put({ ...s, status: "failed" });
  }
}
