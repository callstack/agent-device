// Seeded corpus mutator for the parser fuzz lane (#1414).
//
// A seeded PRNG rather than fast-check: the lane needs reproducible cases it can print as a
// one-line repro command and append to a checked-in corpus, and nothing here benefits from
// shrinking a structured arbitrary. Same seed + same iteration count = same cases, on every
// machine and every Node version.

/** mulberry32 — small, deterministic, dependency-free. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Characters that historically break hand-written parsers: quote/escape state, delimiter
// lookalikes, structural JSON/YAML punctuation, astral-plane and combining code points,
// bidi and zero-width controls.
const HOSTILE_CHUNKS = [
  '"',
  "'",
  '\\',
  '\\"',
  '`',
  '=',
  '==',
  '&&',
  '||',
  '--',
  '---',
  '#',
  ':',
  ',',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  '$',
  '${',
  '${}',
  '@',
  '~=',
  '*',
  '\n',
  '\r\n',
  '\t',
  ' ',
  '\u0000',
  '\u200b',
  '\u202e',
  '\ufeff',
  '🚀',
  'é\u0301',
  '𝕏',
  '-0',
  'NaN',
  'Infinity',
  '1e999',
  '9007199254740993',
  'null',
  'undefined',
  '__proto__',
  'constructor',
];

type Mutator = (input: string, random: () => number) => string;

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

function index(input: string, random: () => number): number {
  return input.length === 0 ? 0 : Math.floor(random() * input.length);
}

const MUTATORS: readonly Mutator[] = [
  // insert a hostile chunk
  (input, random) => {
    const at = index(input, random);
    return input.slice(0, at) + pick(HOSTILE_CHUNKS, random) + input.slice(at);
  },
  // delete a slice
  (input, random) => {
    const at = index(input, random);
    const length = 1 + Math.floor(random() * 8);
    return input.slice(0, at) + input.slice(at + length);
  },
  // duplicate a slice
  (input, random) => {
    const at = index(input, random);
    const length = 1 + Math.floor(random() * 16);
    const slice = input.slice(at, at + length);
    return input.slice(0, at) + slice + slice + input.slice(at);
  },
  // swap two characters
  (input, random) => {
    if (input.length < 2) return input + pick(HOSTILE_CHUNKS, random);
    const a = index(input, random);
    const b = index(input, random);
    const chars = [...input];
    [chars[a], chars[b]] = [chars[b]!, chars[a]!];
    return chars.join('');
  },
  // truncate — the classic "half-typed input" shape
  (input, random) => input.slice(0, index(input, random)),
  // repeat the whole input, to probe quadratic/backtracking behavior
  (input, random) => {
    const times = 2 + Math.floor(random() * 6);
    return input.repeat(times);
  },
  // long run of one character (regex backtracking bait)
  (input, random) => {
    const at = index(input, random);
    const chunk = pick(HOSTILE_CHUNKS, random);
    return input.slice(0, at) + chunk.repeat(50 + Math.floor(random() * 200)) + input.slice(at);
  },
];

/** One mutated case derived from `seeds`, deterministic in `random`'s stream position. */
function mutateCase(seeds: readonly string[], random: () => number): string {
  let input = pick(seeds, random);
  const rounds = 1 + Math.floor(random() * 4);
  for (let round = 0; round < rounds; round += 1) {
    input = pick(MUTATORS, random)(input, random);
  }
  // Unbounded growth would measure the mutator, not the parsers.
  return input.length > 20000 ? input.slice(0, 20000) : input;
}

/**
 * The full case list for a run: every seed verbatim first (so the lane always covers the
 * valid shapes), then mutated cases until `iterations` is reached.
 */
export function generateCases(
  seeds: readonly string[],
  iterations: number,
  seed: number,
): string[] {
  const random = createRandom(seed);
  const cases = [...seeds];
  while (cases.length < iterations) cases.push(mutateCase(seeds, random));
  return cases.slice(0, Math.max(iterations, seeds.length));
}
