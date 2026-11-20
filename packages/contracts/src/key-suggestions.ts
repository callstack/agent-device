/**
 * The shared nearest-name rule behind "Did you mean ...?" refusals, so every
 * surface that refuses an unknown name offers the same quality of recovery.
 * The rules follow the CLI parser's command and flag suggestions
 * (`src/cli/parser/command-suggestions.ts`): 1-2 character tokens never get a
 * suggestion, exact prefix matches win, and otherwise only ties at the minimum
 * edit distance are kept, within a length-derived threshold, capped at three
 * and ordered deterministically — a strong match is never bundled with a
 * coincidental weak one.
 */

const NEAREST_SUGGESTION_LIMIT = 3;

export function suggestClosestKey(
  token: string,
  candidates: readonly string[],
): string | undefined {
  if (token.length <= 2) return undefined;
  const prefixMatches = candidates.filter((name) => name.startsWith(token));
  if (prefixMatches.length > 0) {
    const closest = prefixMatches.sort(shortestThenAlpha).slice(0, NEAREST_SUGGESTION_LIMIT);
    if (closest.length === 1) return closest[0];
    return `one of: ${closest.join(', ')}`;
  }
  const scored = candidates
    .map((name) => ({ name, distance: keyDistance(token, name) }))
    .filter((entry) => entry.distance <= nearestMatchThreshold(token));
  if (scored.length === 0) return undefined;
  const best = Math.min(...scored.map((entry) => entry.distance));
  const closest = scored
    .filter((entry) => entry.distance === best)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, NEAREST_SUGGESTION_LIMIT)
    .map((entry) => entry.name);
  if (closest.length === 1) return closest[0];
  return `one of: ${closest.join(', ')}`;
}

function shortestThenAlpha(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b);
}

function nearestMatchThreshold(token: string): number {
  if (token.length < 4) return 1;
  if (token.length <= 6) return 2;
  return 3;
}

function keyDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.startsWith(b) || b.startsWith(a)) {
    return Math.abs(a.length - b.length);
  }
  return levenshteinDistance(a, b);
}

function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distances: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) distances[i]![0] = i;
  for (let j = 0; j < cols; j += 1) distances[0]![j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      distances[i]![j] = Math.min(
        distances[i - 1]![j]! + 1,
        distances[i]![j - 1]! + 1,
        distances[i - 1]![j - 1]! + cost,
      );
    }
  }
  return distances[rows - 1]![cols - 1]!;
}
