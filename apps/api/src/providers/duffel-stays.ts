import type { City, HotelOption } from "@travellite/schema";
import { z } from "zod";
import { DUFFEL_API, duffelHeaders } from "./duffel-flights.js";
import type { Fx } from "./fx.js";
import { haversineKm, nightsBetween, normalizeItems, round2 } from "./normalize.js";
import { fail, ok, type Result, type SearchProvider } from "./provider.js";
import type { ResilientHttp } from "./resilience.js";

export interface HotelSearchParams {
  city: City;
  checkin: string;
  checkout: string;
  travelers: number;
}

export const HOTELS_PER_PAIR = 10;
export const SEARCH_RADIUS_KM = 5;

const RawResult = z.object({
  id: z.string(),
  cheapest_rate_total_amount: z.string().regex(/^\d+(\.\d+)?$/),
  cheapest_rate_currency: z.string().length(3),
  accommodation: z.object({
    name: z.string(),
    /** Star rating, 1–5. */
    rating: z.number().nullish(),
    /** Guest score, 0–10. */
    review_score: z.number().nullish(),
    location: z
      .object({
        geographic_coordinates: z.object({ latitude: z.number(), longitude: z.number() }).nullish(),
      })
      .nullish(),
  }),
});
type RawResult = z.infer<typeof RawResult>;

const RawResponse = z.object({ data: z.object({ results: z.array(z.unknown()) }) });

export interface DuffelStaysOptions {
  http: ResilientHttp;
  fx: Fx;
  token: string;
  onDropped?: (count: number) => void;
}

/** Guest score mapped to 0–5, falling back to the star rating. */
function rating(a: RawResult["accommodation"]): number | undefined {
  if (a.review_score != null) return round2(Math.min(10, Math.max(0, a.review_score)) / 2);
  if (a.rating != null) return Math.min(5, Math.max(0, a.rating));
  return undefined;
}

export function googleHotelsUrl(name: string, city: City): string {
  return `https://www.google.com/travel/search?q=${encodeURIComponent(`${name} ${city.name}`)}`;
}

/** Hotels within SEARCH_RADIUS_KM of the city center, best rated first. */
export class DuffelStays implements SearchProvider<HotelSearchParams> {
  readonly name = "duffel" as const;
  readonly category = "hotel" as const;

  constructor(private readonly opts: DuffelStaysOptions) {}

  async search(p: HotelSearchParams, signal?: AbortSignal): Promise<Result<HotelOption[]>> {
    const nights = nightsBetween(p.checkin, p.checkout);
    if (nights < 1) return fail("NOT_FOUND", { detail: "checkout not after checkin" });

    const res = await this.opts.http.request(
      {
        method: "POST",
        url: `${DUFFEL_API}/stays/search`,
        headers: duffelHeaders(this.opts.token),
        body: {
          data: {
            rooms: Math.ceil(p.travelers / 2),
            guests: Array.from({ length: p.travelers }, () => ({ type: "adult" })),
            check_in_date: p.checkin,
            check_out_date: p.checkout,
            location: {
              radius: SEARCH_RADIUS_KM,
              geographic_coordinates: { latitude: p.city.center.lat, longitude: p.city.center.lng },
            },
          },
        },
      },
      signal,
    );
    if (!res.ok) return res;

    const body = RawResponse.safeParse(res.value.body);
    if (!body.success) return fail("BAD_PAYLOAD", { detail: "stays response shape" });

    const { options, dropped } = await normalizeItems(
      body.data.data.results,
      RawResult,
      async (r) => {
        const usd = await this.opts.fx.toUsd(
          Number(r.cheapest_rate_total_amount),
          r.cheapest_rate_currency,
        );
        if (usd === null) return null;
        const coords = r.accommodation.location?.geographic_coordinates;
        const location = coords ? { lat: coords.latitude, lng: coords.longitude } : undefined;
        const score = rating(r.accommodation);
        return {
          id: `duffel:${r.id}`,
          category: "hotel",
          title: r.accommodation.name.slice(0, 200),
          price: { amount: round2(usd), currency: "USD" },
          // The cheapest rate's total covers the whole stay.
          price_basis: "total",
          ...(score === undefined ? {} : { rating: score }),
          ...(location ? { location } : {}),
          url: googleHotelsUrl(r.accommodation.name, p.city),
          attrs: {
            checkin: p.checkin,
            checkout: p.checkout,
            nights,
            ...(location ? { km_from_center: round2(haversineKm(location, p.city.center)) } : {}),
          },
        } satisfies HotelOption;
      },
    );
    if (dropped) this.opts.onDropped?.(dropped);

    const hotels = (options as HotelOption[])
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.price.amount - b.price.amount)
      .slice(0, HOTELS_PER_PAIR);
    return ok(hotels);
  }
}
