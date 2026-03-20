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

/**
 * Parse a `%.name` sugar string into a `param` expression.
 *
 * @param s — a string starting with `%.` (e.g. `"%.auId"`)
 * @returns an object `{ param: string }` ready for evaluation
 * @throws if the name is empty or contains dots
 */
export function parseParamSugar(s: string): { param: string } {
  const name = s.slice(2); // strip "%."
  if (name === "" || name.includes(".")) {
    throw new Error(`Invalid param sugar: "${s}"`);
  }
  return { param: name };
}

/**
 * Parse a `@.name` sugar string into a `ref` expression.
 *
 * @param s — a string starting with `@.` (e.g. `"@.score"`)
 * @returns an object `{ ref: string }` ready for evaluation
 * @throws if the name is empty or contains dots
 */
export function parseRefSugar(s: string): { ref: string } {
  const name = s.slice(2); // strip "@."
  if (name === "" || name.includes(".")) {
    throw new Error(`Invalid ref sugar: "${s}"`);
  }
  return { ref: name };
}
