import { listCliCommandNames } from '../../command-catalog.ts';

/**
 * Curated guess -> canonical command mapping for unknown CLI command names.
 *
 * Agents (and humans) commonly guess command names that don't exist under that
 * spelling, such as `relaunch` instead of `open <app> --relaunch`. Each entry's
 * `command` must resolve to a real, registered CLI command name; the
 * "alias suggestion targets exist" test in
 * `src/cli/parser/__tests__/command-suggestions.test.ts` fails the build on drift.
 */
type CommandAliasSuggestion = {
  /** Canonical command name this guess should have used. */
  command: string;
  /** Full example invocation shown to the user. */
  example: string;
};

const COMMAND_ALIAS_SUGGESTIONS: Record<string, CommandAliasSuggestion> = {
  launch: { command: 'open', example: 'open <app> --relaunch' },
  relaunch: { command: 'open', example: 'open <app> --relaunch' },
  start: { command: 'open', example: 'open <app> --relaunch' },
  restart: { command: 'open', example: 'open <app> --relaunch' },
  touch: { command: 'press', example: 'press' },
  input: { command: 'fill', example: 'fill' },
  settext: { command: 'fill', example: 'fill' },
  entertext: { command: 'fill', example: 'fill' },
  screencap: { command: 'screenshot', example: 'screenshot' },
  capture: { command: 'screenshot', example: 'screenshot' },
  dismiss: { command: 'keyboard', example: 'keyboard dismiss' },
};

export function listCommandAliasSuggestionEntries(): Array<[string, CommandAliasSuggestion]> {
  return Object.entries(COMMAND_ALIAS_SUGGESTIONS);
}

function getCuratedCommandSuggestion(command: string): string | undefined {
  return COMMAND_ALIAS_SUGGESTIONS[command]?.example;
}

const NEAREST_COMMAND_SUGGESTION_LIMIT = 3;

/**
 * Nearest registered command names for an unrecognized command, ranked by a
 * prefix-aware edit distance. Names are derived from the live command
 * descriptor registry (via `listCliCommandNames`), never hardcoded, so the
 * suggestion list can't drift from what the CLI actually supports.
 */
export function getNearestCommandNames(command: string): string[] {
  const names = listCliCommandNames();
  const scored = names
    .map((name) => ({ name, distance: commandNameDistance(command, name) }))
    .filter((entry) => entry.distance <= nearestMatchThreshold(command))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name));
  return scored.slice(0, NEAREST_COMMAND_SUGGESTION_LIMIT).map((entry) => entry.name);
}

function nearestMatchThreshold(command: string): number {
  if (command.length <= 3) return 1;
  if (command.length <= 6) return 2;
  return 3;
}

function commandNameDistance(a: string, b: string): number {
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

/**
 * Builds the "Did you mean ...?" fragment for an unknown command, or
 * `undefined` when neither the curated alias map nor the nearest-name
 * fallback has a confident suggestion.
 */
export function suggestCommandFor(command: string): string | undefined {
  const curated = getCuratedCommandSuggestion(command);
  if (curated) return curated;
  const nearest = getNearestCommandNames(command);
  if (nearest.length === 0) return undefined;
  if (nearest.length === 1) return nearest[0];
  return `one of: ${nearest.join(', ')}`;
}

// Unknown flag names that read like an app/bundle identity concept. `open` (and
// the commands the curated map above points agents toward) take the app or
// bundle id as a positional argument, not a flag, so a bare "Unknown flag"
// error leaves agents guessing. Kept intentionally narrow to avoid false
// positives on unrelated unknown flags.
const POSITIONAL_APP_FLAG_GUESSES = new Set([
  '--bundle-id',
  '--bundleid',
  '--bundle',
  '--package',
  '--package-name',
  '--packagename',
  '--app-id',
  '--appid',
  '--pkg',
]);

export function formatUnknownFlagMessage(token: string): string {
  if (POSITIONAL_APP_FLAG_GUESSES.has(token.toLowerCase())) {
    return `Unknown flag: ${token}. The app or bundle id is a positional argument, e.g. open <app> --relaunch.`;
  }
  return `Unknown flag: ${token}`;
}
