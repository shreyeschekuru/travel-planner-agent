import type { FlightOption } from "@travellite/schema";
import { z } from "zod";
import type { Fx } from "./fx.js";
import { isoDurationMinutes, normalizeItems, round2 } from "./normalize.js";
import { fail, ok, type Result, type SearchProvider } from "./provider.js";
import type { ResilientHttp } from "./resilience.js";

export const DUFFEL_API = "https://api.duffel.com";

export function duffelHeaders(token: string): Record<string, string> {
  return {
    accept: "application/json",
    "duffel-version": "v2",
    authorization: `Bearer ${token}`,
  };
}

export interface FlightSearchParams {
  origin: string;
  destination: string;
  depart: string;
  return: string;
  travelers: number;
}

/** Most offers kept per date pair. */
export const FLIGHTS_PER_PAIR = 10;

const RawSegment = z.object({
  departing_at: z.string(),
  arriving_at: z.string(),
});
const RawSlice = z.object({
  duration: z.string().nullish(),
  segments: z.array(RawSegment).min(1),
});
const RawOffer = z.object({
  id: z.string(),
  total_amount: z.string().regex(/^\d+(\.\d+)?$/),
  total_currency: z.string().length(3),
  owner: z.object({ name: z.string(), iata_code: z.string().nullish() }),
  slices: z.array(RawSlice).length(2),
});
type RawOffer = z.infer<typeof RawOffer>;

const RawResponse = z.object({ data: z.object({ offers: z.array(z.unknown()) }) });

export interface DuffelFlightsOptions {
  http: ResilientHttp;
  fx: Fx;
  token: string;
  /** Passed to Duffel so airlines answer before our own timeout fires. */
  supplierTimeoutMs: number;
  onDropped?: (count: number) => void;
}

// Segment times are airport-local, so they can't be subtracted across time zones;
// offers without a slice duration are dropped.
const sliceMinutes = (slice: RawOffer["slices"][number]) =>
  slice.duration ? isoDurationMinutes(slice.duration) : null;

export function googleFlightsUrl(p: FlightSearchParams): string {
  const q = `Flights from ${p.origin} to ${p.destination} on ${p.depart} through ${p.return}`;
  return `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;
}

/** Round-trip economy offers for one date pair, cheapest first. */
export class DuffelFlights implements SearchProvider<FlightSearchParams> {
  readonly name = "duffel" as const;
  readonly category = "flight" as const;

  constructor(private readonly opts: DuffelFlightsOptions) {}

  async search(p: FlightSearchParams, signal?: AbortSignal): Promise<Result<FlightOption[]>> {
    const url = `${DUFFEL_API}/air/offer_requests?return_offers=true&supplier_timeout=${this.opts.supplierTimeoutMs}`;
    const res = await this.opts.http.request(
      {
        method: "POST",
        url,
        headers: duffelHeaders(this.opts.token),
        body: {
          data: {
            slices: [
              { origin: p.origin, destination: p.destination, departure_date: p.depart },
              { origin: p.destination, destination: p.origin, departure_date: p.return },
            ],
            passengers: Array.from({ length: p.travelers }, () => ({ type: "adult" })),
            cabin_class: "economy",
            max_connections: 2,
          },
        },
      },
      signal,
    );
    if (!res.ok) return res;

    const body = RawResponse.safeParse(res.value.body);
    if (!body.success) return fail("BAD_PAYLOAD", { detail: "offer response shape" });

    const link = googleFlightsUrl(p);
    const { options, dropped } = await normalizeItems(
      body.data.data.offers,
      RawOffer,
      async (o) => {
        const [out, back] = o.slices;
        const outFirst = out?.segments[0];
        const outLast = out?.segments.at(-1);
        const backFirst = back?.segments[0];
        const backLast = back?.segments.at(-1);
        const minutes = out ? sliceMinutes(out) : null;
        if (!out || !back || !outFirst || !outLast || !backFirst || !backLast || !minutes)
          return null;
        const usd = await this.opts.fx.toUsd(Number(o.total_amount), o.total_currency);
        if (usd === null) return null;
        const stops = Math.max(out.segments.length, back.segments.length) - 1;
        const stopLabel = stops === 0 ? "nonstop" : `${stops} stop${stops > 1 ? "s" : ""}`;
        return {
          id: `duffel:${o.id}`,
          category: "flight",
          title: `${o.owner.name}, ${stopLabel}`,
          price: { amount: round2(usd), currency: "USD" },
          // Duffel's total_amount covers every passenger on the offer.
          price_basis: "total",
          url: link,
          attrs: {
            depart_at: outFirst.departing_at,
            arrive_at: outLast.arriving_at,
            return_depart_at: backFirst.departing_at,
            return_arrive_at: backLast.arriving_at,
            stops,
            duration_min: minutes,
            carrier: (o.owner.iata_code ?? o.owner.name).slice(0, 64),
          },
        } satisfies FlightOption;
      },
    );
    if (dropped) this.opts.onDropped?.(dropped);

    const flights = (options as FlightOption[])
      .sort((a, b) => a.price.amount - b.price.amount)
      .slice(0, FLIGHTS_PER_PAIR);
    return ok(flights);
  }
}
