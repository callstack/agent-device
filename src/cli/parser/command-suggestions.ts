import { RETIRED_SCREENSHOT_MAX_SIZE } from '@agent-device/contracts/capture';
import { listCliCommandNames } from '@agent-device/command-registry/catalog';
import { getFlagDefinitions } from '../../commands/schema/command-schema.ts';
import { isFlagSupportedForCommand } from '../../commands/schema/option-schema.ts';

/**
 * Curated guess -> canonical command mapping for unknown CLI command names.
 *
 * Agents (and humans) commonly guess command names that don't exist under that
 * spelling, such as `restart` instead of `open <app> --relaunch`. Keys must be
 * lowercase (lookups lowercase the input token first). Each entry's `command`
 * must resolve to a real, registered CLI command name, and each `example` must
 * parse as a valid invocation of it; the registry-drift tests in
 * `src/cli/parser/__tests__/command-suggestions.test.ts` fail the build on drift.
 *
 * True aliases (`tap` -> press, `launch`/`relaunch` -> open) are normalized
 * case-insensitively in `normalizeCommandAlias`
 * (args.ts) before the
 * unknown-command check runs, so they never reach this map and must not be
 * listed here. `start`/`restart` stay suggestion-only: `start` is genuinely
 * ambiguous, so a hint beats silently guessing.
 */
type CommandAliasSuggestion = {
  /** Canonical command name this guess should have used. */
  command: string;
  /** Full example invocation shown to the user. */
  example: string;
};

const OPEN_RELAUNCH_EXAMPLE = 'open <app> --relaunch';

const COMMAND_ALIAS_SUGGESTIONS: Record<string, CommandAliasSuggestion> = {
  start: { command: 'open', example: OPEN_RELAUNCH_EXAMPLE },
  restart: { command: 'open', example: OPEN_RELAUNCH_EXAMPLE },
  touch: { command: 'press', example: 'press' },
  input: { command: 'fill', example: 'fill' },
  settext: { command: 'fill', example: 'fill' },
  entertext: { command: 'fill', example: 'fill' },
  screencap: { command: 'screenshot', example: 'screenshot' },
  capture: { command: 'screenshot', example: 'screenshot' },
  dismiss: { command: 'keyboard', example: 'keyboard dismiss' },
  'get-text': { command: 'get', example: 'get text' },
  gettext: { command: 'get', example: 'get text' },
  get_text: { command: 'get', example: 'get text' },
  'open-url': { command: 'open', example: 'open <url>' },
  'close-session': { command: 'close', example: 'close' },
};

/**
 * @internal Exposes the curated suggestion map for drift/parity tests.
 */
export function listCommandAliasSuggestionEntries(): Array<[string, CommandAliasSuggestion]> {
  return Object.entries(COMMAND_ALIAS_SUGGESTIONS);
}

const NEAREST_SUGGESTION_LIMIT = 3;

/**
 * Nearest registered command names for an unrecognized (lowercased) command
 * token. Names are derived from the live command descriptor registry (via
 * `listCliCommandNames`), never hardcoded, so the suggestion list can't drift
 * from what the CLI actually supports.
 *
 * Precision rules: 1-2 character tokens never get a suggestion, exact prefix
 * matches win outright, and otherwise only ties at the minimum edit distance
 * are kept so a strong match is not bundled with a coincidental weak one.
 */
function getNearestCommandNames(command: string): string[] {
  if (command.length <= 2) return [];
  const names = listCliCommandNames();
  const prefixMatches = names.filter((name) => name.startsWith(command));
  if (prefixMatches.length > 0) {
    return prefixMatches.sort(shortestThenAlpha).slice(0, NEAREST_SUGGESTION_LIMIT);
  }
  return getClosestNames(command, names);
}

function shortestThenAlpha(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b);
}

/**
 * The shared nearest-name rule: keep only the closest candidates within a
 * length-derived threshold, so a strong match is never bundled with a
 * coincidental weak one.
 */
function getClosestNames(token: string, candidates: readonly string[]): string[] {
  const scored = candidates
    .map((name) => ({ name, distance: nameDistance(token, name) }))
    .filter((entry) => entry.distance <= nearestMatchThreshold(token));
  if (scored.length === 0) return [];
  const best = Math.min(...scored.map((entry) => entry.distance));
  return scored
    .filter((entry) => entry.distance === best)
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, NEAREST_SUGGESTION_LIMIT)
    .map((entry) => entry.name);
}

function nearestMatchThreshold(token: string): number {
  if (token.length < 4) return 1;
  if (token.length <= 6) return 2;
  return 3;
}

function nameDistance(a: string, b: string): number {
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
 * fallback has a confident suggestion. Matching is case-insensitive so
 * `RELAUNCH` and `Touch` get the same hint as their lowercase forms.
 */
export function suggestCommandFor(command: string): string | undefined {
  const normalized = command.toLowerCase();
  const curated = COMMAND_ALIAS_SUGGESTIONS[normalized]?.example;
  if (curated) return curated;
  const nearest = getNearestCommandNames(normalized);
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

// `--session-locked` and `--session-lock-conflicts` are no longer flags; point
// callers at the single `--session-lock reject|strip` flag instead of a bare
// "Unknown flag" error.
const REMOVED_SESSION_LOCK_ALIASES = new Set(['--session-locked', '--session-lock-conflicts']);

/**
 * Curated guess -> canonical flag name for unknown CLI flag names.
 *
 * Agents reach for the conventional spellings of an output path before reading the
 * synopsis, and the nearest-name fallback below cannot bridge `--path` to `--out` at
 * edit distance 4. An entry is offered only when the command in scope accepts the
 * named flag, so a guess that means something else there — `trace --path`, whose
 * path is positional and `--out`-less — falls through instead of being pushed at it.
 * Keys must be lowercase and are matched case-insensitively.
 */
const FLAG_NAME_SUGGESTIONS: Record<string, string> = {
  '--output': '--out',
  '--path': '--out',
};

/**
 * @internal Exposes the curated flag-name map for drift tests.
 */
export function listFlagNameSuggestionEntries(): Array<[string, string]> {
  return Object.entries(FLAG_NAME_SUGGESTIONS);
}

/**
 * Builds the "Did you mean ...?" fragment for an unknown flag under the command
 * in scope, or `undefined` when neither the curated guess map nor the nearest-name
 * fallback has a confident suggestion. Candidates come from the live flag registry
 * filtered by what that command actually accepts, so the suggestion cannot drift
 * from the accepted surface and never names a flag the command would refuse.
 */
export function suggestFlagFor(token: string, command: string | null): string | undefined {
  const normalized = token.toLowerCase();
  const curated = FLAG_NAME_SUGGESTIONS[normalized];
  if (curated && isFlagTokenSupportedForCommand(curated, command)) return curated;
  const nearest = getNearestFlagNames(normalized, command);
  if (nearest.length === 0) return undefined;
  if (nearest.length === 1) return nearest[0];
  return `one of: ${nearest.join(', ')}`;
}

function isFlagTokenSupportedForCommand(token: string, command: string | null): boolean {
  const definition = getFlagDefinitions().find((candidate) => candidate.names.includes(token));
  return definition ? isFlagSupportedForCommand(definition.key, command) : false;
}

function getNearestFlagNames(token: string, command: string | null): string[] {
  const bareToken = stripFlagDashes(token);
  if (bareToken.length <= 2) return [];
  const names = listSupportedFlagNames(command);
  const prefixMatches = names.filter((name) => stripFlagDashes(name).startsWith(bareToken));
  if (prefixMatches.length > 0) {
    return prefixMatches.sort(shortestThenAlpha).slice(0, NEAREST_SUGGESTION_LIMIT);
  }
  const closest = getClosestNames(
    bareToken,
    names.map((name) => stripFlagDashes(name)),
  );
  return closest.map((name) => `--${name}`);
}

function listSupportedFlagNames(command: string | null): string[] {
  const names = new Set<string>();
  for (const definition of getFlagDefinitions()) {
    if (!isFlagSupportedForCommand(definition.key, command)) continue;
    const primary = definition.names[0];
    if (primary) names.add(primary);
  }
  return [...names];
}

function stripFlagDashes(token: string): string {
  return token.replace(/^--?/, '');
}

export function formatUnknownFlagMessage(token: string, command: string | null): string {
  const normalized = token.toLowerCase();
  if (POSITIONAL_APP_FLAG_GUESSES.has(normalized)) {
    return `Unknown flag: ${token}. The app or bundle id is a positional argument, e.g. ${OPEN_RELAUNCH_EXAMPLE}.`;
  }
  if (REMOVED_SESSION_LOCK_ALIASES.has(normalized)) {
    return `Unknown flag: ${token}. Use --session-lock reject|strip instead.`;
  }
  if (normalized === RETIRED_SCREENSHOT_MAX_SIZE.cliToken) {
    return `Unknown flag: ${token}. ${RETIRED_SCREENSHOT_MAX_SIZE.migration.screenshot}. ${RETIRED_SCREENSHOT_MAX_SIZE.migration.record}.`;
  }
  const suggestion = suggestFlagFor(token, command);
  if (suggestion) return `Unknown flag: ${token}. Did you mean ${suggestion}?`;
  return `Unknown flag: ${token}`;
}
