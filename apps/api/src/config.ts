import { z } from "zod";

const KeyRing = z
  .string()
  .min(1, "INSTALL_TOKEN_KEYS is required")
  .transform((raw, ctx) => {
    const keys = raw.split(",").map((pair) => {
      const i = pair.indexOf(":");
      return { kid: pair.slice(0, i).trim(), secret: pair.slice(i + 1).trim() };
    });
    for (const k of keys) {
      if (!/^[a-z0-9]{1,16}$/.test(k.kid) || k.secret.length < 32) {
        ctx.addIssue({
          code: "custom",
          message: "Each INSTALL_TOKEN_KEYS entry must be kid:secret with a secret of >= 32 chars",
        });
        return z.NEVER;
      }
    }
    return keys;
  });

const csv = z
  .string()
  .default("")
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );

const ProviderMode = z.enum(["fixture", "live"]);
export type ProviderMode = z.infer<typeof ProviderMode>;

export const ConfigSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    REDIS_URL: z.string().url().default("redis://localhost:6379"),
    INSTALL_TOKEN_KEYS: KeyRing,
    EXTENSION_IDS: csv,
    ANTHROPIC_API_KEY: z.string().optional(),
    LLM_DAILY_SPEND_CAP_USD: z.coerce.number().positive().default(20),
    LLM_MAX_CONCURRENCY: z.coerce.number().int().positive().default(20),
    /**
     * "fixture" replays fixtures/ and needs no provider credentials. "live" makes every provider
     * live and overrides the per-provider modes below, which apply only in fixture mode.
     */
    PROVIDER_MODE: ProviderMode.default("fixture"),
    FLIGHTS_MODE: ProviderMode.default("fixture"),
    HOTELS_MODE: ProviderMode.default("fixture"),
    ACTIVITIES_MODE: ProviderMode.default("fixture"),
    FIXTURES_DIR: z.string().optional(),
    DUFFEL_ACCESS_TOKEN: z.string().optional(),
    VIATOR_API_KEY: z.string().optional(),
    /** Requests per second per provider, shared by all instances. */
    DUFFEL_RATE_PER_SEC: z.coerce.number().positive().default(5),
    VIATOR_RATE_PER_SEC: z.coerce.number().positive().default(10),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV === "production" && c.EXTENSION_IDS.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["EXTENSION_IDS"],
        message: "Required in production (the event stream checks Origin against it)",
      });
    }
    const modes = providerModes(c);
    const why = (setting: string) =>
      c.PROVIDER_MODE === "live" ? "PROVIDER_MODE=live" : `${setting}=live`;
    const required: [boolean, "DUFFEL_ACCESS_TOKEN" | "VIATOR_API_KEY", string][] = [
      [modes.flights === "live", "DUFFEL_ACCESS_TOKEN", why("FLIGHTS_MODE")],
      [modes.hotels === "live", "DUFFEL_ACCESS_TOKEN", why("HOTELS_MODE")],
      [modes.activities === "live", "VIATOR_API_KEY", why("ACTIVITIES_MODE")],
    ];
    const reported = new Set<string>();
    for (const [live, key, reason] of required) {
      if (!live || c[key] || reported.has(key)) continue;
      reported.add(key);
      ctx.addIssue({ code: "custom", path: [key], message: `Required when ${reason}` });
    }
  });
export type Config = z.infer<typeof ConfigSchema>;

export interface ProviderModes {
  flights: ProviderMode;
  hotels: ProviderMode;
  activities: ProviderMode;
}

/** PROVIDER_MODE=live makes every provider live; otherwise each follows its own setting. */
export function providerModes(
  c: Pick<Config, "PROVIDER_MODE" | "FLIGHTS_MODE" | "HOTELS_MODE" | "ACTIVITIES_MODE">,
): ProviderModes {
  if (c.PROVIDER_MODE === "live") return { flights: "live", hotels: "live", activities: "live" };
  return { flights: c.FLIGHTS_MODE, hotels: c.HOTELS_MODE, activities: c.ACTIVITIES_MODE };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
