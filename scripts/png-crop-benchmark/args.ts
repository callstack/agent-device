/** The command line `pnpm bench:png-crop` accepts. */

export type BenchmarkOptions = Readonly<{
  rounds: number;
  jsonPath: string | undefined;
  captureFiles: readonly string[];
}>;

const DEFAULT_ROUNDS = 5;

export function parseBenchmarkArgs(argv: readonly string[]): BenchmarkOptions {
  return {
    rounds: readNumber(argv, '--rounds') ?? DEFAULT_ROUNDS,
    jsonPath: readString(argv, '--json'),
    captureFiles: readAll(argv, '--file'),
  };
}

function readNumber(argv: readonly string[], flag: string): number | undefined {
  const value = readString(argv, flag);
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined;
}

function readString(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readAll(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  argv.forEach((entry, index) => {
    if (entry === flag && argv[index + 1] !== undefined) values.push(argv[index + 1]!);
  });
  return values;
}
