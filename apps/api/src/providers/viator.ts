import type { ActivityOption, City, Preference } from "@travellite/schema";
import { z } from "zod";
import type { JsonCache } from "../store/cache.js";
import { haversineKm, normalizeItems, round2 } from "./normalize.js";
import { fail, ok, type Result, type SearchProvider } from "./provider.js";
import type { ResilientHttp } from "./resilience.js";

export const VIATOR_API = "https://api.viator.com/partner";
export const ACTIVITIES_LIMIT = 20;
const LOOKUP_TTL_SECONDS = 7 * 86_400;

export interface ActivitySearchParams {
  city: City;
}

/** Tag names are matched against these to fill ActivityAttrs.tags. */
const PREFERENCE_PATTERNS: [Preference, RegExp][] = [
  ["beach", /\b(beach|snorkel|surf|island|boat|sailing|cruise)/i],
  ["museums", /\b(museum|gallery|art|histor|heritage|monument|palace|castle)/i],
  ["food", /\b(food|culinary|cooking|wine|tasting|dining|market|street food)/i],
  ["nightlife", /\b(nightlife|night tour|bar|pub|club|cabaret|show)/i],
  ["outdoors", /\b(outdoor|hik|nature|park|bike|kayak|adventure|wildlife|volcano)/i],
  ["shopping", /\b(shopping|outlet|souvenir)/i],
  ["family", /\b(family|kid|child|zoo|aquarium|theme park)/i],
  ["relaxed_pace", /\b(spa|wellness|relax|hot spring|scenic)/i],
];

export function preferencesFor(tagNames: string[]): Preference[] {
  const text = tagNames.join(" | ");
  return PREFERENCE_PATTERNS.filter(([, re]) => re.test(text)).map(([p]) => p);
}

const RawDestinations = z.object({
  destinations: z.array(
    z.object({
      destinationId: z.number().int(),
      name: z.string(),
      type: z.string(),
      center: z.object({ latitude: z.number(), longitude: z.number() }).nullish(),
    }),
  ),
});

const RawTags = z.object({
  tags: z.array(
    z.object({
      tagId: z.number().int(),
      allNamesByLocale: z.record(z.string(), z.string()).nullish(),
    }),
  ),
});

const RawProduct = z.object({
  productCode: z.string(),
  title: z.string(),
  productUrl: z.string(),
  reviews: z.object({ combinedAverageRating: z.number().nullish() }).nullish(),
  duration: z
    .object({
      fixedDurationInMinutes: z.number().nullish(),
      variableDurationFromMinutes: z.number().nullish(),
    })
    .nullish(),
  pricing: z.object({
    summary: z.object({ fromPrice: z.number().nonnegative() }),
    currency: z.literal("USD"),
  }),
  tags: z.array(z.number().int()).nullish(),
});

const RawSearch = z.object({ products: z.array(z.unknown()).nullish() });

export interface ViatorOptions {
  http: ResilientHttp;
  cache: JsonCache;
  apiKey: string;
  onDropped?: (count: number) => void;
}

/** Top-rated experiences in a city. Prices are "from" prices per person. */
export class ViatorActivities implements SearchProvider<ActivitySearchParams> {
  readonly name = "viator" as const;
  readonly category = "activity" as const;

  constructor(private readonly opts: ViatorOptions) {}

  private headers(): Record<string, string> {
    return {
      accept: "application/json;version=2.0",
      "accept-language": "en-US",
      "exp-api-key": this.opts.apiKey,
    };
  }

  async search(p: ActivitySearchParams, signal?: AbortSignal): Promise<Result<ActivityOption[]>> {
    const [dest, tags] = await Promise.all([
      this.destinationId(p.city, signal),
      this.tagNames(signal),
    ]);
    if (!dest.ok) return dest;
    // Tags only enrich results; search without them if the lookup failed.
    const tagMap = tags.ok ? tags.value : new Map<number, string>();

    const res = await this.opts.http.request(
      {
        method: "POST",
        url: `${VIATOR_API}/products/search`,
        headers: this.headers(),
        body: {
          filtering: { destination: String(dest.value) },
          sorting: { sort: "TRAVELER_RATING", order: "DESCENDING" },
          pagination: { start: 1, count: ACTIVITIES_LIMIT },
          currency: "USD",
        },
      },
      signal,
    );
    if (!res.ok) return res;
    const body = RawSearch.safeParse(res.value.body);
    if (!body.success) return fail("BAD_PAYLOAD", { detail: "products/search shape" });

    const { options, dropped } = await normalizeItems(body.data.products ?? [], RawProduct, (r) => {
      const minutes = r.duration?.fixedDurationInMinutes ?? r.duration?.variableDurationFromMinutes;
      const names = (r.tags ?? []).flatMap((id) => tagMap.get(id) ?? []);
      const rating = r.reviews?.combinedAverageRating;
      return {
        id: `viator:${r.productCode}`,
        category: "activity",
        title: r.title.slice(0, 200),
        price: { amount: round2(r.pricing.summary.fromPrice), currency: "USD" },
        price_basis: "per_person",
        ...(rating == null ? {} : { rating: Math.min(5, Math.max(0, rating)) }),
        url: r.productUrl,
        attrs: {
          tags: preferencesFor(names),
          ...(minutes ? { duration_min: Math.round(minutes) } : {}),
        },
      } satisfies ActivityOption;
    });
    if (dropped) this.opts.onDropped?.(dropped);

    const activities = (options as ActivityOption[])
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .slice(0, ACTIVITIES_LIMIT);
    return ok(activities);
  }

  /** Viator's ID for the city: same name, type CITY, nearest to our center. */
  private async destinationId(city: City, signal?: AbortSignal): Promise<Result<number>> {
    const cacheName = `viator:dest:${city.id}`;
    const cached = await this.opts.cache.getJson<number>(cacheName);
    if (cached !== null) return ok(cached);

    const res = await this.opts.http.request(
      { method: "GET", url: `${VIATOR_API}/destinations`, headers: this.headers() },
      signal,
    );
    if (!res.ok) return res;
    const body = RawDestinations.safeParse(res.value.body);
    if (!body.success) return fail("BAD_PAYLOAD", { detail: "destinations shape" });

    const distance = (c: { latitude: number; longitude: number } | null | undefined) =>
      c ? haversineKm({ lat: c.latitude, lng: c.longitude }, city.center) : Infinity;
    const match = body.data.destinations
      .filter((d) => d.type === "CITY" && d.name.toLowerCase() === city.name.toLowerCase())
      .filter((d) => distance(d.center) < 100 || !d.center)
      .sort((a, b) => distance(a.center) - distance(b.center))[0];
    if (!match) return fail("NOT_FOUND", { detail: `no Viator destination for ${city.id}` });

    await this.opts.cache.setJson(cacheName, match.destinationId, LOOKUP_TTL_SECONDS);
    return ok(match.destinationId);
  }

  private async tagNames(signal?: AbortSignal): Promise<Result<Map<number, string>>> {
    const cacheName = "viator:tags";
    const cached = await this.opts.cache.getJson<[number, string][]>(cacheName);
    if (cached) return ok(new Map(cached));

    const res = await this.opts.http.request(
      { method: "GET", url: `${VIATOR_API}/products/tags`, headers: this.headers() },
      signal,
    );
    if (!res.ok) return res;
    const body = RawTags.safeParse(res.value.body);
    if (!body.success) return fail("BAD_PAYLOAD", { detail: "tags shape" });

    const entries = body.data.tags.flatMap((t): [number, string][] => {
      const name = t.allNamesByLocale?.en;
      return name ? [[t.tagId, name]] : [];
    });
    await this.opts.cache.setJson(cacheName, entries, LOOKUP_TTL_SECONDS);
    return ok(new Map(entries));
  }
}
