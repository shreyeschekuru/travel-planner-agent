import { describe, expect, it } from "vitest";
import { InstallTokens, bearerToken } from "../src/auth/install-token.js";
import { isAllowedExtensionOrigin } from "../src/auth/origin.js";

const k1 = { kid: "k1", secret: "a".repeat(32) };
const k2 = { kid: "k2", secret: "b".repeat(32) };

describe("InstallTokens", () => {
  it("issues tokens that verify", () => {
    const tokens = new InstallTokens([k1]);
    const { token, claims } = tokens.issue();
    expect(tokens.verify(token)).toEqual(claims);
    expect(claims.iid).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects a forged signature", () => {
    const tokens = new InstallTokens([k1]);
    const { token } = tokens.issue();
    const [p, payload] = token.split(".");
    expect(tokens.verify(`${p}.${payload}.${"A".repeat(43)}`)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const tokens = new InstallTokens([k1]);
    const { token } = tokens.issue();
    const [p, , sig] = token.split(".");
    const other = Buffer.from(JSON.stringify({ iid: "f".repeat(32), iat: 1, kid: "k1" })).toString(
      "base64url",
    );
    expect(tokens.verify(`${p}.${other}.${sig}`)).toBeNull();
  });

  it("rejects tokens signed with a key outside the ring", () => {
    const { token } = new InstallTokens([k2]).issue();
    expect(new InstallTokens([k1]).verify(token)).toBeNull();
  });

  it("supports rotation: new key signs, old key still verifies", () => {
    const old = new InstallTokens([k1]).issue().token;
    const rotated = new InstallTokens([k2, k1]);
    expect(rotated.verify(old)).not.toBeNull();
    expect(rotated.issue().claims.kid).toBe("k2");
  });

  it("rejects expired tokens", () => {
    const tokens = new InstallTokens([k1], 60);
    const { token } = tokens.issue(Date.parse("2026-01-01T00:00:00Z"));
    expect(tokens.verify(token, Date.parse("2026-01-01T00:02:00Z"))).toBeNull();
  });

  it.each(["", "garbage", "tl1.x.y", "tl2.a.b", "tl1.a.b.c"])("rejects malformed %j", (t) => {
    expect(new InstallTokens([k1]).verify(t)).toBeNull();
  });
});

describe("bearerToken", () => {
  it("extracts a bearer token", () => {
    expect(bearerToken("Bearer tl1.abc.defghijk")).toBe("tl1.abc.defghijk");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe("isAllowedExtensionOrigin", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";
  it("allows only listed extension ids", () => {
    expect(isAllowedExtensionOrigin(`chrome-extension://${id}`, [id])).toBe(true);
    expect(isAllowedExtensionOrigin(`chrome-extension://${id}`, [])).toBe(false);
    expect(isAllowedExtensionOrigin("https://evil.example", [id])).toBe(false);
    expect(isAllowedExtensionOrigin(undefined, [id])).toBe(false);
  });
});
