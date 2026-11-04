import type {
  PackageExplanation,
  SavedItinerary,
  TripPackage,
  VacationConfig,
} from "@travellite/schema";

export const config: VacationConfig = {
  origin: "JFK",
  destination: "lisbon-pt",
  departure_date: "2027-03-10",
  return_date: "2027-03-15",
  date_flex_days: 0,
  budget_usd: 4000,
  travelers: 2,
  preferences: ["food"],
};

export function pkg(
  id: string,
  label: TripPackage["label"] = "best_value",
  total = 3500,
): TripPackage {
  return {
    id,
    label,
    total_usd: total,
    score: 0.8,
    score_breakdown: {
      cost_fit: 0.9,
      flight_convenience: 0.7,
      hotel_location: 0.6,
      rating: 0.8,
      pref_match: 0.5,
    },
    flight: {
      id: `duffel:off_${id}`,
      category: "flight",
      title: "TAP Air Portugal, nonstop",
      price: { amount: 1400, currency: "USD" },
      price_basis: "total",
      url: "https://www.google.com/travel/flights?q=x",
      attrs: {
        depart_at: "2027-03-10T18:00:00",
        arrive_at: "2027-03-11T06:30:00",
        return_depart_at: "2027-03-15T11:00:00",
        return_arrive_at: "2027-03-15T14:00:00",
        stops: 0,
        duration_min: 450,
        carrier: "TP",
      },
    },
    hotel: {
      id: `duffel:srr_${id}`,
      category: "hotel",
      title: `Hotel ${id}`,
      price: { amount: 1100, currency: "USD" },
      price_basis: "total",
      rating: 4.2,
      url: "https://www.google.com/travel/search?q=x",
      attrs: { checkin: "2027-03-10", checkout: "2027-03-15", nights: 5, km_from_center: 1.3 },
    },
    activities: [
      {
        id: `viator:${id}1`,
        category: "activity",
        title: "Lisbon Food Tour",
        price: { amount: 80, currency: "USD" },
        price_basis: "per_person",
        rating: 4.8,
        url: "https://www.viator.com/tours/x",
        attrs: { tags: ["food"], duration_min: 180 },
      },
    ],
  };
}

export const explanation = (id: string): PackageExplanation => ({
  package_id: id,
  headline: `Headline for ${id}`,
  pros: [
    { text: "Total $3,500, within your $4,000 budget", source_fields: ["total"] },
    { text: "Nonstop flight, 7h30m", source_fields: ["fl.stops"] },
  ],
  cons: [{ text: "Hotel is 1.3 km from the center", source_fields: ["ht.km"] }],
});

export const itinerary = (id: string, over: Partial<SavedItinerary> = {}): SavedItinerary => ({
  session_id: id,
  package_label: "best_value",
  destination: "lisbon-pt",
  dates: { departure: "2027-03-10", return: "2027-03-15" },
  selections: {
    flight: {
      url: "https://www.google.com/travel/flights?q=x",
      summary: "TAP, departs 2027-03-10 18:00",
    },
    hotel: { url: "https://www.google.com/travel/search?q=x", summary: "Hotel A, 5 nights" },
    activities: [{ url: "https://www.viator.com/tours/x", summary: "Lisbon Food Tour" }],
  },
  total_usd: 3500,
  created_at: "2026-11-03T12:00:00.000Z",
  status: "saved",
  ...over,
});
