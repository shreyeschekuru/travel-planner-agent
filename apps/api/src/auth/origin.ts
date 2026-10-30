/**
 * True when the Origin header is one of our extension IDs. Used on the SSE route,
 * where browsers send Origin: chrome-extension://<id>.
 */
export function isAllowedExtensionOrigin(
  origin: string | undefined,
  allowedIds: readonly string[],
): boolean {
  if (!origin) return false;
  const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  return !!m && allowedIds.includes(m[1]!);
}
