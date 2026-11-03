/**
 * Writes synthetic fixtures for every catalog city by running the real adapters against
 * the fake providers in synthetic.ts. Real recordings (record-fixtures.ts) overwrite these.
 *
 *   npm run fixtures:synth -w @travellite/api
 */
import { CITIES } from "@travellite/schema";
import { findFixturesDir, recordingTransport } from "../src/providers/fixtures.js";
import { standaloneProviders } from "./standalone.js";
import { NO_FLIGHTS, SPECIAL_ORIGINS, TEST_CITIES, syntheticTransport } from "./synthetic.js";

/** Recorded trip; replay shifts these dates to whatever is requested. */
export const SYNTH_DATES = { depart: "2026-12-04", return: "2026-12-11" };
const ORIGINS = ["JFK", "SFO", "LAX", "ORD"];
const TRAVELERS = [1, 2];

const dir = findFixturesDir();
const p = standaloneProviders(recordingTransport(syntheticTransport, dir, true), {
  duffel: "synthetic",
  viator: "synthetic",
});

const flight = (origin: string, destination: string, travelers: number) =>
  p.flights.search({ origin, destination, ...SYNTH_DATES, travelers });

const jobs: Promise<unknown>[] = [];
for (const city of CITIES) {
  for (const travelers of TRAVELERS) {
    for (const origin of ORIGINS) jobs.push(flight(origin, city.iata, travelers));
    jobs.push(
      p.hotels.search({
        city,
        checkin: SYNTH_DATES.depart,
        checkout: SYNTH_DATES.return,
        travelers,
      }),
    );
  }
}
await Promise.all(jobs);
// Sequential, so the Viator lookups are recorded once and then served from memory.
for (const city of [...CITIES, ...Object.values(TEST_CITIES)]) await p.activities.search({ city });
for (const city of Object.values(TEST_CITIES)) {
  await p.hotels.search({
    city,
    checkin: SYNTH_DATES.depart,
    checkout: SYNTH_DATES.return,
    travelers: 2,
  });
}
await flight(SPECIAL_ORIGINS.invalid, "PAR", 2);
await flight(SPECIAL_ORIGINS.rateLimited, "PAR", 2);
await flight(NO_FLIGHTS.origin, NO_FLIGHTS.destination, 2);

console.log(`Synthetic fixtures written to ${dir}`);
