import type { Claim } from "@travellite/schema";

/** Reads a dotted path ("fl.stops", "acts.0.title") from the model's input. */
export function readPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    if (!Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

export function numbersIn(text: string): number[] {
  return (text.match(NUMBER) ?? [])
    .map((n) => Number(n.replaceAll(",", "")))
    .filter(Number.isFinite);
}

function numbersInValue(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (typeof value === "string") return numbersIn(value);
  if (Array.isArray(value)) return value.flatMap(numbersInValue);
  if (value && typeof value === "object") return Object.values(value).flatMap(numbersInValue);
  return [];
}

/**
 * A claim is grounded when every cited field exists in the package's input, and every number
 * in its text equals (±1, for rounding) a number found in those fields (design.md §5.6).
 */
export function isGrounded(claim: Claim, input: unknown): boolean {
  const values = claim.source_fields.map((f) => readPath(input, f));
  if (values.some((v) => v === undefined)) return false;
  const allowed = values.flatMap(numbersInValue);
  return numbersIn(claim.text).every((n) => allowed.some((a) => Math.abs(a - n) <= 1));
}
