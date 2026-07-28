// Command-line surface for `pnpm fuzz:parsers` (#1414).

import { parseArgs } from 'node:util';

export type FuzzOptions = {
  target?: string;
  iterations: number;
  seed: number;
  caseTimeoutMs: number;
  artifactDir: string;
  inputFile?: string;
  appendCorpus: boolean;
  replayCorpus: boolean;
  selfCheck: boolean;
};

export const FUZZ_USAGE = `Usage: pnpm fuzz:parsers [options]

  --target <name>        Fuzz one target only (default: all)
  --iterations <n>       Cases per target (default: 2000)
  --seed <n>             fast-check seed (default: 1). Same seed = same cases.
  --case-timeout-ms <n>  Per-case watchdog budget (default: 2000)
  --artifact-dir <dir>   Where failing cases are written (default: .tmp/fuzz)
  --input-file <file>    Replay a single saved failing case (JSON artifact) and exit
  --append-corpus        Promote failures (incl. an --input-file artifact) into the corpus
  --replay-corpus        Replay the checked-in corpus instead of generating cases
  --self-check           Run the broken-on-purpose targets and require each to be caught
`;

const DEFAULTS = {
  iterations: '2000',
  seed: '1',
  caseTimeoutMs: '2000',
  artifactDir: '.tmp/fuzz',
} as const;

function positiveInt(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer (got ${String(raw)}).`);
  }
  return value;
}

/** `{ key: value }`, or nothing when the flag was not passed (exactOptionalPropertyTypes). */
function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/**
 * Options to fall back on when argv itself is unusable, so a malformed dispatch input still
 * produces an envelope. `--artifact-dir` is recovered positionally: the value that decides *where*
 * monitoring looks must survive a rejected flag elsewhere in argv.
 */
export function fallbackFuzzOptions(argv: readonly string[]): FuzzOptions {
  const flag = argv.indexOf('--artifact-dir');
  const dir = flag === -1 ? undefined : argv[flag + 1];
  return {
    iterations: Number(DEFAULTS.iterations),
    seed: Number(DEFAULTS.seed),
    caseTimeoutMs: Number(DEFAULTS.caseTimeoutMs),
    artifactDir: dir !== undefined && !dir.startsWith('--') ? dir : DEFAULTS.artifactDir,
    appendCorpus: false,
    replayCorpus: false,
    selfCheck: argv.includes('--self-check'),
  };
}

/** Parses argv into options; `null` means usage was requested and nothing should run. */
export function readFuzzOptions(argv: readonly string[]): FuzzOptions | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      target: { type: 'string' },
      iterations: { type: 'string', default: DEFAULTS.iterations },
      seed: { type: 'string', default: DEFAULTS.seed },
      'case-timeout-ms': { type: 'string', default: DEFAULTS.caseTimeoutMs },
      'artifact-dir': { type: 'string', default: DEFAULTS.artifactDir },
      'input-file': { type: 'string' },
      'append-corpus': { type: 'boolean', default: false },
      'replay-corpus': { type: 'boolean', default: false },
      'self-check': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });
  if (values.help === true) return null;
  return {
    ...optional('target', values.target),
    ...optional('inputFile', values['input-file']),
    iterations: positiveInt(values.iterations, 'iterations'),
    seed: positiveInt(values.seed, 'seed'),
    caseTimeoutMs: positiveInt(values['case-timeout-ms'], 'case-timeout-ms'),
    artifactDir: String(values['artifact-dir']),
    appendCorpus: values['append-corpus'] === true,
    replayCorpus: values['replay-corpus'] === true,
    selfCheck: values['self-check'] === true,
  };
}
