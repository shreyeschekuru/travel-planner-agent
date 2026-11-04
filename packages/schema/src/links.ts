/** Booking links must be https and on one of these hosts. Checked by the API and the extension. */
export const BOOKING_HOSTS: ReadonlySet<string> = new Set(["www.google.com", "www.viator.com"]);

export function isAllowedBookingUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && BOOKING_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}
