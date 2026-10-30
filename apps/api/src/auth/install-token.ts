import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface SigningKey {
  kid: string;
  secret: string;
}

export interface InstallClaims {
  /** Install ID: random, identifies one extension install. */
  iid: string;
  /** Issued-at, seconds since epoch. */
  iat: number;
  kid: string;
}

const PREFIX = "tl1";
const b64 = (buf: Buffer) => buf.toString("base64url");

/**
 * HMAC-signed install tokens: `tl1.<payload>.<signature>`.
 * The first key in the ring signs; every key in the ring verifies, so keys can rotate
 * by adding a new key first and removing the old one later.
 */
export class InstallTokens {
  constructor(
    private readonly ring: SigningKey[],
    private readonly maxAgeSeconds = 400 * 24 * 60 * 60,
  ) {
    if (ring.length === 0) throw new Error("Install token key ring is empty");
  }

  issue(now = Date.now()): { token: string; claims: InstallClaims } {
    const signer = this.ring[0]!;
    const claims: InstallClaims = {
      iid: randomBytes(16).toString("hex"),
      iat: Math.floor(now / 1000),
      kid: signer.kid,
    };
    const payload = b64(Buffer.from(JSON.stringify(claims)));
    return { token: `${PREFIX}.${payload}.${this.sign(signer.secret, payload)}`, claims };
  }

  /** Returns the claims, or null for any malformed, forged, unknown-key or expired token. */
  verify(token: string, now = Date.now()): InstallClaims | null {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;
    const [, payload, signature] = parts as [string, string, string];

    let claims: InstallClaims;
    try {
      claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as InstallClaims;
    } catch {
      return null;
    }
    if (
      typeof claims.iid !== "string" ||
      !/^[0-9a-f]{32}$/.test(claims.iid) ||
      typeof claims.iat !== "number" ||
      typeof claims.kid !== "string"
    ) {
      return null;
    }

    const key = this.ring.find((k) => k.kid === claims.kid);
    if (!key) return null;

    const expected = Buffer.from(this.sign(key.secret, payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    const age = Math.floor(now / 1000) - claims.iat;
    if (age < -300 || age > this.maxAgeSeconds) return null;
    return claims;
  }

  private sign(secret: string, payload: string): string {
    return b64(createHmac("sha256", secret).update(`${PREFIX}.${payload}`).digest());
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9._-]{10,1024})$/.exec(header);
  return m?.[1] ?? null;
}
