import type { JsonCache } from "../store/cache.js";
import type { Transport } from "./http.js";

export const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const CACHE_NAME = "fx:ecb";
const CACHE_TTL_SECONDS = 12 * 3600;

/** Units of each currency per 1 EUR. */
type Rates = Record<string, number>;

export function parseEcbXml(xml: string): Rates {
  const rates: Rates = { EUR: 1 };
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    const rate = Number(m[2]);
    if (m[1] && rate > 0) rates[m[1]] = rate;
  }
  return rates;
}

/** Converts provider prices to USD using the ECB daily reference rates, cached in Redis. */
export class Fx {
  private inflight: Promise<Rates | null> | null = null;

  constructor(
    private readonly transport: Transport,
    private readonly cache: JsonCache,
    private readonly timeoutMs = 2000,
  ) {}

  /** Null when the rate is unknown; callers drop the item. */
  async toUsd(amount: number, currency: string): Promise<number | null> {
    if (currency === "USD") return amount;
    const rates = await this.rates();
    const from = rates?.[currency];
    const usd = rates?.USD;
    if (!from || !usd) return null;
    return (amount / from) * usd;
  }

  private rates(): Promise<Rates | null> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<Rates | null> {
    const cached = await this.cache.getJson<Rates>(CACHE_NAME);
    if (cached) return cached;
    try {
      const res = await this.transport(
        { method: "GET", url: ECB_URL },
        AbortSignal.timeout(this.timeoutMs),
      );
      if (res.status !== 200 || typeof res.body !== "string") return null;
      const rates = parseEcbXml(res.body);
      if (!rates.USD) return null;
      await this.cache.setJson(CACHE_NAME, rates, CACHE_TTL_SECONDS);
      return rates;
    } catch {
      return null;
    }
  }
}
