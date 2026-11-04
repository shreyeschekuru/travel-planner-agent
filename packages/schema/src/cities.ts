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

export interface Airport {
  code: string;
  city: string;
}

/** Suggested origins for autocomplete. Any valid IATA code is accepted. */
export const AIRPORTS: readonly Airport[] = [
  { code: "ATL", city: "Atlanta" },
  { code: "AUS", city: "Austin" },
  { code: "BNA", city: "Nashville" },
  { code: "BOS", city: "Boston" },
  { code: "BWI", city: "Baltimore" },
  { code: "CLT", city: "Charlotte" },
  { code: "DCA", city: "Washington (Reagan)" },
  { code: "DEN", city: "Denver" },
  { code: "DFW", city: "Dallas/Fort Worth" },
  { code: "DTW", city: "Detroit" },
  { code: "EWR", city: "Newark" },
  { code: "FLL", city: "Fort Lauderdale" },
  { code: "HNL", city: "Honolulu" },
  { code: "IAD", city: "Washington (Dulles)" },
  { code: "IAH", city: "Houston" },
  { code: "JFK", city: "New York (JFK)" },
  { code: "LAS", city: "Las Vegas" },
  { code: "LAX", city: "Los Angeles" },
  { code: "LGA", city: "New York (LaGuardia)" },
  { code: "MCO", city: "Orlando" },
  { code: "MIA", city: "Miami" },
  { code: "MSP", city: "Minneapolis" },
  { code: "ORD", city: "Chicago (O'Hare)" },
  { code: "PDX", city: "Portland" },
  { code: "PHL", city: "Philadelphia" },
  { code: "PHX", city: "Phoenix" },
  { code: "SAN", city: "San Diego" },
  { code: "SEA", city: "Seattle" },
  { code: "SFO", city: "San Francisco" },
  { code: "SLC", city: "Salt Lake City" },
  { code: "TPA", city: "Tampa" },
  { code: "YVR", city: "Vancouver" },
  { code: "YYZ", city: "Toronto" },
];
