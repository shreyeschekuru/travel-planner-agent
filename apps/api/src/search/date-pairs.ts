const DAY_MS = 86_400_000;

export interface DatePair {
  depart: string;
  return: string;
  /** Days moved from the requested dates (negative = earlier). */
  shift: number;
}

const addDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Candidate date pairs for a ±flexDays window. The whole trip moves together, so its length
 * stays the same. Pairs departing before today are dropped. Requested dates come first.
 */
export function datePairs(
  depart: string,
  ret: string,
  flexDays: number,
  now = new Date(),
): DatePair[] {
  const today = now.toISOString().slice(0, 10);
  const shifts = [0];
  for (let d = 1; d <= flexDays; d++) shifts.push(-d, d);
  return shifts
    .map((shift) => ({ depart: addDays(depart, shift), return: addDays(ret, shift), shift }))
    .filter((p) => p.depart >= today && p.return > p.depart);
}
