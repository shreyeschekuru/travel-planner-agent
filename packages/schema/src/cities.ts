import type { LatLng } from "./primitives.js";

export interface City {
  id: string;
  name: string;
  country: string;
  /** IATA city code (covers all airports) or the main airport code. */
  iata: string;
  /** City center, used for hotel search radius and distance scoring. */
  center: LatLng;
}

/** Destinations the MVP supports. The extension autocompletes from this list. */
export const CITIES: readonly City[] = [
  {
    id: "amsterdam-nl",
    name: "Amsterdam",
    country: "NL",
    iata: "AMS",
    center: { lat: 52.3731, lng: 4.8926 },
  },
  {
    id: "barcelona-es",
    name: "Barcelona",
    country: "ES",
    iata: "BCN",
    center: { lat: 41.3874, lng: 2.1686 },
  },
  {
    id: "cancun-mx",
    name: "Cancun",
    country: "MX",
    iata: "CUN",
    center: { lat: 21.1619, lng: -86.8515 },
  },
  {
    id: "honolulu-us",
    name: "Honolulu",
    country: "US",
    iata: "HNL",
    center: { lat: 21.3069, lng: -157.8583 },
  },
  {
    id: "lisbon-pt",
    name: "Lisbon",
    country: "PT",
    iata: "LIS",
    center: { lat: 38.7223, lng: -9.1393 },
  },
  {
    id: "london-gb",
    name: "London",
    country: "GB",
    iata: "LON",
    center: { lat: 51.5072, lng: -0.1276 },
  },
  {
    id: "mexico-city-mx",
    name: "Mexico City",
    country: "MX",
    iata: "MEX",
    center: { lat: 19.4326, lng: -99.1332 },
  },
  {
    id: "new-york-us",
    name: "New York",
    country: "US",
    iata: "NYC",
    center: { lat: 40.758, lng: -73.9855 },
  },
  {
    id: "paris-fr",
    name: "Paris",
    country: "FR",
    iata: "PAR",
    center: { lat: 48.8566, lng: 2.3522 },
  },
  {
    id: "rome-it",
    name: "Rome",
    country: "IT",
    iata: "ROM",
    center: { lat: 41.9028, lng: 12.4964 },
  },
  {
    id: "tokyo-jp",
    name: "Tokyo",
    country: "JP",
    iata: "TYO",
    center: { lat: 35.6812, lng: 139.7671 },
  },
  {
    id: "reykjavik-is",
    name: "Reykjavik",
    country: "IS",
    iata: "REK",
    center: { lat: 64.1466, lng: -21.9426 },
  },
];

const byId = new Map(CITIES.map((c) => [c.id, c]));

export function cityById(id: string): City | undefined {
  return byId.get(id);
}
