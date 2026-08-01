/** Removes only leading and trailing hyphens in a single linear scan. */
export function trimBoundaryHyphens(value: string): string {
  let start = 0;
  while (value.charCodeAt(start) === 45) start += 1;

  let end = value.length;
  while (end > start && value.charCodeAt(end - 1) === 45) end -= 1;

  return value.slice(start, end);
}
