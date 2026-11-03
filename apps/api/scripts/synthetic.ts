/**
 * A fake Duffel, Viator and ECB that answer in each API's wire format. Used to generate
 * fixtures until real recordings exist; every generated file is marked "synthetic".
 */
import { createHash } from "node:crypto";
import { CITIES, type City } from "@travellite/schema";
import type { HttpRequest, HttpResponse, Transport } from "../src/providers/http.js";
import { ECB_URL } from "../src/providers/fx.js";

/** Cities used only by tests, for provider edge cases. */
export const TEST_CITIES = {
  empty: {
    id: "emptyville-zz",
    name: "Emptyville",
    country: "ZZ",
    iata: "EMP",
    center: { lat: -10.5, lng: -20.5 },
  },
  rateLimited: {
    id: "ratelimitville-zz",
    name: "Ratelimitville",
    country: "ZZ",
    iata: "RLV",
    center: { lat: -11.5, lng: -21.5 },
  },
  /** Coordinates the hotel provider rejects. */
  invalid: {
    id: "nowhere-zz",
    name: "Nowhere",
    country: "ZZ",
    iata: "NWH",
    center: { lat: 0, lng: 0 },
  },
} satisfies Record<string, City>;

/** Origins with special behavior. */
export const SPECIAL_ORIGINS = { invalid: "ZZZ", rateLimited: "QRL" };
/** Origin/destination pair with no flights. */
export const NO_FLIGHTS = { origin: "ORD", destination: "REK" };
/** City whose activities provider is down (the degraded case). */
export const DEGRADED_ACTIVITIES_CITY = "cancun-mx";

const ALL_CITIES: City[] = [...CITIES, ...Object.values(TEST_CITIES)];
/** Synthetic Viator destination IDs; real ones replace them when recorded. */
const destId = (c: City) => 90_000 + ALL_CITIES.indexOf(c);

/** Relative price level per city; Reykjavik and Tokyo are the budget-breach cases. */
const PRICE_LEVEL: Record<string, number> = {
  "reykjavik-is": 2.2,
  "tokyo-jp": 1.9,
  "honolulu-us": 1.6,
  "london-gb": 1.5,
  "paris-fr": 1.4,
  "new-york-us": 1.4,
  "amsterdam-nl": 1.3,
  "rome-it": 1.2,
  "barcelona-es": 1.1,
  "lisbon-pt": 1.0,
  "cancun-mx": 0.9,
  "mexico-city-mx": 0.8,
};
/** Some providers answer in local currency, to exercise USD conversion. */
const HOTEL_CURRENCY: Record<string, string> = { "london-gb": "GBP", "tokyo-jp": "JPY" };
const USD_PER = { USD: 1, GBP: 1.27, JPY: 0.0067 } as Record<string, number>;

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
<Cube><Cube time="2026-11-02">
<Cube currency='USD' rate='1.0800'/><Cube currency='JPY' rate='161.20'/><Cube currency='GBP' rate='0.8500'/>
<Cube currency='ISK' rate='150.10'/><Cube currency='MXN' rate='19.90'/>
</Cube></Cube>
</gesmes:Envelope>`;

const TAGS = [
  "Beach & Island Tours",
  "Museums & Exhibitions",
  "Food Tours",
  "Wine Tastings",
  "Nightlife",
  "Hiking",
  "Bike Tours",
  "Shopping Tours",
  "Family-friendly",
  "Spas",
  "Historical Tours",
  "Boat Tours",
  "Cooking Classes",
  "Art Galleries",
  "Kayaking",
  "Scenic Drives",
];
const CARRIERS = [
  ["American Airlines", "AA"],
  ["Delta Air Lines", "DL"],
  ["United Airlines", "UA"],
  ["British Airways", "BA"],
  ["Lufthansa", "LH"],
  ["Air France", "AF"],
  ["Iberia", "IB"],
  ["JetBlue", "B6"],
] as const;
const HOTEL_WORDS = [
  "Grand",
  "Central",
  "Garden",
  "Harbor",
  "Old Town",
  "Riverside",
  "Plaza",
  "Boutique",
  "Park",
  "Royal",
  "Station",
  "Artisan",
  "Terrace",
  "Hostel",
];
const ACTIVITY_WORDS = [
  "Walking Tour",
  "Food Tour",
  "Museum Pass",
  "Sunset Cruise",
  "Day Trip",
  "Cooking Class",
  "Bike Tour",
  "Night Tour",
  "Wine Tasting",
  "Kayak Trip",
  "Old Town Tour",
  "Market Visit",
];

function rng(seed: string) {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body,
});
const duration = (min: number) => `PT${Math.floor(min / 60)}H${String(min % 60).padStart(2, "0")}M`;
const localTime = (date: string, minutesAfterMidnight: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + minutesAfterMidnight * 60_000)
    .toISOString()
    .slice(0, 19);

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function offers(body: Body): HttpResponse {
  const slices = body.data.slices as {
    origin: string;
    destination: string;
    departure_date: string;
  }[];
  const travelers = (body.data.passengers as unknown[]).length;
  const [out, back] = slices;
  if (!out || !back) return json(422, { errors: [{ code: "validation_error" }] });
  if (out.origin === SPECIAL_ORIGINS.invalid) {
    return json(422, {
      errors: [{ code: "validation_error", title: "Invalid origin", source: { field: "origin" } }],
    });
  }
  if (out.origin === SPECIAL_ORIGINS.rateLimited) {
    return json(429, { errors: [{ code: "rate_limit_exceeded" }] }, { "retry-after": "1" });
  }
  if (out.origin === NO_FLIGHTS.origin && out.destination === NO_FLIGHTS.destination) {
    return json(200, { data: { id: "orq_empty", offers: [] } });
  }
  const city = CITIES.find((c) => c.iata === out.destination);
  const level = PRICE_LEVEL[city?.id ?? ""] ?? 1;
  const r = rng(`${out.origin}-${out.destination}-${travelers}`);
  const list: unknown[] = [];
  for (let i = 0; i < 12; i++) {
    const [name, code] = CARRIERS[Math.floor(r() * CARRIERS.length)]!;
    const stops = r() < 0.4 ? 0 : r() < 0.8 ? 1 : 2;
    const legMin = Math.round(300 + r() * 420 + stops * 110);
    const slice = (date: string, from: string, to: string, startMin: number) => {
      const segs = [];
      let t = startMin;
      for (let s = 0; s <= stops; s++) {
        const len = Math.round((legMin - stops * 90) / (stops + 1));
        segs.push({
          departing_at: localTime(date, t),
          arriving_at: localTime(date, t + len),
          origin: { iata_code: s === 0 ? from : "XXX" },
          destination: { iata_code: s === stops ? to : "XXX" },
          marketing_carrier: { name, iata_code: code },
          marketing_carrier_flight_number: String(100 + Math.floor(r() * 900)),
        });
        t += len + 90;
      }
      return { duration: duration(legMin), segments: segs };
    };
    const perPerson = (380 + r() * 520) * level * (stops === 0 ? 1.25 : 1);
    list.push({
      id: `off_syn${createHash("sha1").update(`${out.origin}${out.destination}${travelers}${i}`).digest("hex").slice(0, 20)}`,
      total_amount: (perPerson * travelers).toFixed(2),
      total_currency: "USD",
      owner: { name, iata_code: code },
      slices: [
        slice(out.departure_date, out.origin, out.destination, Math.round(360 + r() * 900)),
        slice(back.departure_date, back.origin, back.destination, Math.round(360 + r() * 900)),
      ],
    });
  }
  // One malformed offer per response, to exercise drop-and-count.
  list.push({ id: "off_synbroken", owner: { name: "Broken Air" }, slices: [] });
  return json(200, { data: { id: "orq_syn", offers: list } });
}

function stays(body: Body): HttpResponse {
  const { latitude, longitude } = body.data.location.geographic_coordinates;
  const city = ALL_CITIES.find((c) => c.center.lat === latitude && c.center.lng === longitude);
  if (!city || city === TEST_CITIES.invalid)
    return json(422, { errors: [{ code: "validation_error" }] });
  if (city === TEST_CITIES.rateLimited)
    return json(429, { errors: [{ code: "rate_limit_exceeded" }] }, { "retry-after": "1" });
  if (city === TEST_CITIES.empty) return json(200, { data: { results: [] } });

  const nights = Math.round(
    (Date.parse(body.data.check_out_date) - Date.parse(body.data.check_in_date)) / 86_400_000,
  );
  const rooms = body.data.rooms as number;
  const currency = HOTEL_CURRENCY[city.id] ?? "USD";
  const level = PRICE_LEVEL[city.id] ?? 1;
  const r = rng(`stays-${city.id}-${rooms}`);
  const results = HOTEL_WORDS.map((word, i) => {
    const stars = 2 + Math.floor(r() * 4);
    const nightlyUsd = (60 + stars * 35 + r() * 80) * level;
    const km = r() * 4.5;
    const angle = r() * 2 * Math.PI;
    return {
      id: `srr_syn${createHash("sha1").update(`${city.id}${rooms}${i}`).digest("hex").slice(0, 20)}`,
      check_in_date: body.data.check_in_date,
      check_out_date: body.data.check_out_date,
      cheapest_rate_total_amount: ((nightlyUsd * nights * rooms) / USD_PER[currency]!).toFixed(2),
      cheapest_rate_currency: currency,
      accommodation: {
        id: `acc_syn${i}`,
        name: `${word === "Hostel" ? "" : "Hotel "}${word} ${city.name}${word === "Hostel" ? " Hostel" : ""}`.trim(),
        rating: stars,
        review_score: Math.round((6 + r() * 3.6) * 10) / 10,
        review_count: 50 + Math.floor(r() * 2000),
        location: {
          geographic_coordinates: {
            latitude: city.center.lat + (km / 111) * Math.cos(angle),
            longitude:
              city.center.lng +
              (km / (111 * Math.cos((city.center.lat * Math.PI) / 180))) * Math.sin(angle),
          },
        },
      },
    };
  });
  return json(200, { data: { results, created_at: "2026-11-02T12:00:00Z" } });
}

function viatorSearch(body: Body): HttpResponse {
  const id = Number(body.filtering.destination);
  const city = ALL_CITIES.find((c) => destId(c) === id);
  if (!city) return json(400, { code: "BAD_REQUEST", message: "Invalid destination" });
  if (city === TEST_CITIES.rateLimited)
    return json(429, { code: "TOO_MANY_REQUESTS" }, { "retry-after": "1" });
  if (city.id === DEGRADED_ACTIVITIES_CITY) return json(503, { code: "SERVICE_UNAVAILABLE" });
  if (city === TEST_CITIES.empty) return json(200, { products: [], totalCount: 0 });

  const r = rng(`viator-${city.id}`);
  const slug = city.name.replace(/\s+/g, "-");
  const products = Array.from({ length: 25 }, (_, i) => {
    const word = ACTIVITY_WORDS[i % ACTIVITY_WORDS.length]!;
    const code = `${10000 + i}P${1 + (i % 7)}`;
    return {
      productCode: code,
      title: `${city.name} ${word}${i >= ACTIVITY_WORDS.length ? " (Small Group)" : ""}`,
      description: `A synthetic ${word.toLowerCase()} in ${city.name}.`,
      productUrl: `https://www.viator.com/tours/${slug}/${word.replace(/\s+/g, "-")}/d${id}-${code}?pid=P00000&mcid=42383`,
      reviews: {
        totalReviews: 20 + Math.floor(r() * 3000),
        combinedAverageRating: Math.round((3.8 + r() * 1.2) * 10) / 10,
      },
      duration: { fixedDurationInMinutes: 60 * (1 + Math.floor(r() * 8)) },
      pricing: {
        summary: { fromPrice: Math.round((20 + r() * 160) * (PRICE_LEVEL[city.id] ?? 1)) },
        currency: "USD",
      },
      tags: Array.from(
        { length: 1 + Math.floor(r() * 3) },
        () => 1 + Math.floor(r() * TAGS.length),
      ),
    };
  });
  return json(200, { products, totalCount: products.length });
}

/** Answers any request the adapters make. */
export const syntheticTransport: Transport = async (req: HttpRequest) => {
  const url = new URL(req.url);
  const body = (req.body ?? {}) as Body;
  if (req.url === ECB_URL)
    return { status: 200, headers: { "content-type": "text/xml" }, body: ECB_XML };
  if (url.hostname === "api.duffel.com" && url.pathname === "/air/offer_requests")
    return offers(body);
  if (url.hostname === "api.duffel.com" && url.pathname === "/stays/search") return stays(body);
  if (url.hostname === "api.viator.com") {
    if (url.pathname === "/partner/destinations") {
      return json(200, {
        destinations: ALL_CITIES.map((c) => ({
          destinationId: destId(c),
          name: c.name,
          type: "CITY",
          center: { latitude: c.center.lat, longitude: c.center.lng },
        })),
        totalCount: ALL_CITIES.length,
      });
    }
    if (url.pathname === "/partner/products/tags") {
      return json(200, {
        tags: TAGS.map((name, i) => ({ tagId: i + 1, allNamesByLocale: { en: name } })),
      });
    }
    if (url.pathname === "/partner/products/search") return viatorSearch(body);
  }
  return json(404, { errors: [{ title: "unknown synthetic route" }] });
};
