/**
 * Parse a `$.path.to.value` sugar string into a `select` expression.
 *
 * @param s — a string starting with `$.` (e.g. `"$.context.count"`)
 * @returns an object `{ select: string[] }` ready for evaluation
 * @throws if the path is empty or contains empty segments
 */
export function parseDollarPath(s: string): { select: string[] } {
  const path = s.slice(2); // strip "$."
  if (path === "" || path.startsWith(".") || path.endsWith(".") || path.includes("..")) {
    throw new Error(`Invalid dollar path: "${s}"`);
  }
  return { select: path.split(".") };
}
