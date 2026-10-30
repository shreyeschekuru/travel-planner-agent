import { keys } from "../store/keys.js";
import type { RedisClient } from "../store/redis.js";

/** Amounts are integer nano-USD (1e-9 USD) so Redis counters stay exact. */
export const NANO_PER_USD = 1_000_000_000;

// Reserve ARGV[1] if it fits under the cap ARGV[2]; returns new total or -1.
const RESERVE = `
local cur = tonumber(redis.call("GET", KEYS[1]) or "0")
local amt = tonumber(ARGV[1])
if cur + amt > tonumber(ARGV[2]) then return -1 end
local n = redis.call("INCRBY", KEYS[1], amt)
redis.call("EXPIRE", KEYS[1], 172800)
return n
`;

export interface Reservation {
  day: string;
  amountNano: number;
}

/**
 * Global daily LLM spend cap. Callers reserve a worst-case estimate before each call,
 * then settle with the actual cost. When a reservation would exceed the cap, it fails
 * and the caller falls back to a non-LLM path.
 */
export class SpendGuard {
  constructor(
    private readonly redis: RedisClient,
    private readonly capUsd: number,
  ) {}

  private static day(now: number) {
    return new Date(now).toISOString().slice(0, 10);
  }

  async reserve(amountNano: number, now = Date.now()): Promise<Reservation | null> {
    const amt = Math.max(0, Math.ceil(amountNano));
    const day = SpendGuard.day(now);
    const capNano = Math.floor(this.capUsd * NANO_PER_USD);
    const res = (await this.redis.eval(
      RESERVE,
      1,
      keys.spend(day),
      String(amt),
      String(capNano),
    )) as number;
    return res < 0 ? null : { day, amountNano: amt };
  }

  /** Replace the reserved estimate with the actual amount (refund or top-up). */
  async settle(reservation: Reservation, actualNano: number): Promise<void> {
    const diff = Math.ceil(actualNano) - reservation.amountNano;
    if (diff !== 0) await this.redis.incrby(keys.spend(reservation.day), diff);
  }

  async spentTodayUsd(now = Date.now()): Promise<number> {
    const raw = await this.redis.get(keys.spend(SpendGuard.day(now)));
    return Number(raw ?? 0) / NANO_PER_USD;
  }
}
