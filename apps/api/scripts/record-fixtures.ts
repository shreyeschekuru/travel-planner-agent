/**
 * Records real provider responses into fixtures/, replacing synthetic files with the same
 * key. Request headers (and so API keys) are never written.
 *
 *   PROVIDER_MODE=live DUFFEL_ACCESS_TOKEN=... VIATOR_API_KEY=... \
 *     npm run fixtures:record -w @travellite/api -- [origin] [depart] [return] [travelers]
 */
import { CITIES } from "@travellite/schema";
import { findFixturesDir, recordingTransport } from "../src/providers/fixtures.js";
import { fetchTransport } from "../src/providers/http.js";
import type { Result } from "../src/providers/provider.js";
import { standaloneProviders } from "./standalone.js";

const duffel = process.env.DUFFEL_ACCESS_TOKEN;
const viator = process.env.VIATOR_API_KEY;
if (!duffel || !viator) {
  console.error("Set DUFFEL_ACCESS_TOKEN and VIATOR_API_KEY to record fixtures.");
  process.exit(1);
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const [origin = "JFK", depart = inDays(60), ret = inDays(67), travelers = "2"] =
  process.argv.slice(2);
const dir = findFixturesDir();
// Generous timeouts: recording is offline work and slow answers are still worth keeping.
const p = standaloneProviders(
  recordingTransport(fetchTransport, dir),
  { duffel, viator },
  { timeoutScale: 3 },
);

for (const city of CITIES) {
  const t = Number(travelers);
  const [f, h, a] = await Promise.all([
    p.flights.search({ origin, destination: city.iata, depart, return: ret, travelers: t }),
    p.hotels.search({ city, checkin: depart, checkout: ret, travelers: t }),
    p.activities.search({ city }),
  ]);
  const show = (r: Result<unknown[]>) => (r.ok ? String(r.value.length) : r.error.kind);
  console.log(`${city.id.padEnd(16)} flights ${show(f)}  hotels ${show(h)}  activities ${show(a)}`);
}
console.log(`Recorded to ${dir}`);
