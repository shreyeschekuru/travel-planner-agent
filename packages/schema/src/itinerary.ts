import { z } from "zod";
import { PackageLabel } from "./packages.js";
import { CityId, HttpsUrl, ISODate, ISODateTime } from "./primitives.js";

const Link = z.object({ url: HttpsUrl, summary: z.string().min(1).max(200) });

export const SavedItinerary = z.object({
  session_id: z.uuid(),
  package_label: PackageLabel,
  destination: CityId,
  dates: z.object({ departure: ISODate, return: ISODate }),
  selections: z.object({
    flight: Link,
    hotel: Link,
    activities: z.array(Link),
  }),
  total_usd: z.number().nonnegative(),
  created_at: ISODateTime,
  status: z.enum(["saved", "booked"]),
});
export type SavedItinerary = z.infer<typeof SavedItinerary>;
