// CLI command-line case generation for the `cli-validation` fuzz target (#1781 B2).
//
// The classic mutator splices hazards into a flat string, so a CLI case almost always dies in the
// token scan and the validation layer behind it goes unexercised. These cases are built FROM the
// schema registry — command catalog, per-command positional arity, per-command flag support, flag
// types — so argv tokenizes cleanly and the planted violation surfaces where the generator says
// it does. Each case records the outcome it was built to have; validation-case.ts judges the
// parser against it, which is what makes a silent acceptance (the #1433 class) reportable at all.

import fc from 'fast-check';
import { isKnownCliCommandName, listCliCommandNames } from '../../src/command-catalog.ts';
import {
  getCliCommandSchema,
  getFlagDefinitions,
  type FlagDefinition,
} from '../../src/cli-schema/command-schema.ts';
import { isFlagSupportedForCommand } from '../../src/cli-schema/option-schema.ts';
import { encodeValidationCase, type ValidationCase } from './validation-case.ts';
import { ACCEPT, SAFE_VALUES } from './validation-values.ts';

type CliCommandSurface = {
  name: string;
  /** `null` when the schema allows extra positionals — the arity mutation does not apply. */
  maxPositionals: number | null;
  /** Flags supported for this command, restricted to the unambiguous pool. */
  flags: readonly FlagDefinition[];
};

/**
 * Commands this generator never emits, each with the reason it is out. Declared as data because
 * `validation-arbitraries-cli.test.ts` walks the catalog and fails on any command that is neither
 * reachable nor waived here — and on any waiver the catalog no longer has, so dead entries cannot
 * accumulate the way the Maestro shape table drifted before its coverage assertion existed.
 */
export const UNGENERATED_COMMANDS: Readonly<Record<string, string>> = {
  cdp: 'preserves every post-command argument verbatim, so no planted violation can be refused',
  'react-devtools': 'passes unknown flags through to the local tool instead of refusing them',
  batch: 'its step-source rule has an input space of two strings, pinned as seed cases instead',
};

/** Flag keys this generator never emits, same contract as the commands above. */
export const UNGENERATED_FLAG_KEYS: Readonly<Record<string, string>> = {
  help: 'reroutes parsing to help output, so the planted outcome never happens',
  version: 'reroutes parsing to version output, same as help',
  snapshotDiff: 'rewrites the command to `diff`, so the case no longer asserts what it planted',
  steps: 'belongs to the pinned batch step-source seeds',
  stepsFile: 'belongs to the pinned batch step-source seeds',
  installSource: 'carries no CLI token at all (`names: []`) — reachable only through config',
  batchOnError: 'supported only on `batch`, which is waived above, so no case can carry it',
  batchMaxSteps: 'supported only on `batch`, which is waived above, so no case can carry it',
};

/**
 * Deriving the surface walks the whole command-metadata registry, so it is computed on first use
 * rather than at import: a `--input-file` replay or a classic-target run must not pay for a
 * generator it never asks for (it did, and timed out the coverage-instrumented promotion test).
 */
function memoize<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

let surfaceBuilds = 0;

/**
 * How many times the schema-derived surface has been built. It must still be 0 after importing
 * this module: an eager build cost every harness path — `--input-file` and the classic targets
 * included — the whole command-metadata registry, and timed out the coverage-instrumented
 * promotion test. Asserted in validation-arbitraries.test.ts, which is the actual #1824 guard.
 */
export function validationSurfaceBuildCount(): number {
  return surfaceBuilds;
}

/** Every definition that can be written as a token at all, minus the waived keys. */
const safeFlagPool = memoize<readonly FlagDefinition[]>(() =>
  getFlagDefinitions().filter(
    (definition) => !(definition.key in UNGENERATED_FLAG_KEYS) && definition.names.length > 0,
  ),
);

/** Long token when there is one; short-only definitions (`-i`) are part of the surface too. */
function flagToken(definition: FlagDefinition): string {
  return definition.names.find((name) => name.startsWith('--')) ?? definition.names[0]!;
}

/**
 * Flags this command can carry unambiguously. A token two definitions share (`--port` on `proxy`
 * versus `metro`, `--scope` on `record` versus the snapshot family) is fine as long as only one of
 * them is supported *here* — which is how `resolveFlagDefinition` reads it too. Excluding those
 * tokens outright left six keys silently ungenerated until the coverage assertion said so.
 */
function unambiguousFlagsFor(command: string): readonly FlagDefinition[] {
  const supported = safeFlagPool().filter((definition) =>
    isFlagSupportedForCommand(definition.key, command),
  );
  const perToken = new Map<string, number>();
  for (const definition of supported) {
    const token = flagToken(definition);
    perToken.set(token, (perToken.get(token) ?? 0) + 1);
  }
  return supported.filter((definition) => perToken.get(flagToken(definition)) === 1);
}

const cliSurfaces = memoize<readonly CliCommandSurface[]>(() => {
  surfaceBuilds += 1;
  return listCliCommandNames()
    .filter((name) => !(name in UNGENERATED_COMMANDS))
    .map((name) => {
      const schema = getCliCommandSchema(name);
      return {
        name,
        maxPositionals: schema.allowsExtraPositionals ? null : (schema.positionalArgs?.length ?? 0),
        flags: unambiguousFlagsFor(name),
      };
    });
});

/**
 * A value the schema accepts, salt-selected so a case replays. Floats take endpoints and the
 * midpoint only — modulo arithmetic drifts past a fractional `max` (a 33k slice produced
 * `--scale=1.110000000000017`, which the parser rightly rejected: a phantom, not a bug).
 */
function flagValue(definition: FlagDefinition, salt: number): string {
  const low = definition.min ?? 0;
  const high = definition.max ?? low + 1000;
  switch (definition.type) {
    case 'enum':
      return definition.enumValues![salt % definition.enumValues!.length]!;
    case 'int':
      return String(low + (salt % (high - low + 1)));
    case 'number':
      return String([low, high, (low + high) / 2][salt % 3]);
    default:
      return SAFE_VALUES[salt % SAFE_VALUES.length] || 'value';
  }
}

/** One flag as argv: a bare token for the kinds that take no value, `--flag=value` otherwise. */
function renderFlag(definition: FlagDefinition, salt: number): string {
  const token = flagToken(definition);
  const bare =
    definition.setValue !== undefined ||
    definition.type === 'boolean' ||
    definition.type === 'booleanOrString';
  return bare ? token : `${token}=${flagValue(definition, salt)}`;
}

type CliBase = {
  surface: CliCommandSurface;
  positionals: string[];
  flags: FlagDefinition[];
  salt: number;
};

function validArgv(base: CliBase): string[] {
  return [
    base.surface.name,
    ...base.positionals,
    ...base.flags.map((definition, index) => renderFlag(definition, base.salt + index)),
  ];
}

/**
 * Which parser layer refuses the planted violation. `token-scan` violations are refused inside
 * `parseRawArgs`/`parseFlagValue` while argv is still being scanned — the layer the classic
 * `cli-args` target already reaches; `command-validation` violations survive the scan and are
 * refused by `finalizeParsedArgs` (arity, per-command flag support, command identity), the layer
 * B2 exists to reach. Asserted per class in validation-arbitraries.test.ts, so the lane's real
 * reach stays disclosed rather than implied.
 */
type CliMutationLayer = 'token-scan' | 'command-validation';

type CliMutation = {
  name: string;
  layer: CliMutationLayer;
  /** Relative share of the mutated budget; command-validation classes are weighted up. */
  weight: number;
  /** The `AppError.code` this class must be refused with. */
  code: string;
  apply: (base: CliBase) => Omit<ValidationCase, 'expect'> | null;
};

const isValueFlag = (definition: FlagDefinition) =>
  definition.setValue === undefined &&
  (definition.type === 'string' ||
    definition.type === 'enum' ||
    definition.type === 'int' ||
    definition.type === 'number');

const fakeCommands = memoize(() =>
  ['frobnicate', 'tapp', 'navigate', 'clik', 'snapshoot', 'opne'].filter(
    (name) => !isKnownCliCommandName(name),
  ),
);

/**
 * Five of the seven classes are the same shape: pick a flag the schema says matches, render argv
 * around it. Writing that out per class duplicated the picker and restated each class name inside
 * its own body, where it could drift from the declared `name`; the factory owns both.
 */
function flagMutation(spec: {
  name: string;
  layer: CliMutationLayer;
  weight: number;
  code: string;
  /** Flags this class can plant, from the schema — empty means the class does not apply. */
  candidates: (base: CliBase) => readonly FlagDefinition[];
  argv: (definition: FlagDefinition, base: CliBase) => string[];
}): CliMutation {
  const { candidates, argv, ...declaration } = spec;
  return {
    ...declaration,
    apply: (base) => {
      const pool = candidates(base);
      const definition = pool[base.salt % pool.length];
      return definition ? { payload: argv(definition, base), mutation: spec.name } : null;
    },
  };
}

const CLI_MUTATIONS: readonly CliMutation[] = [
  {
    // #1433: a bounded command must refuse extra positionals instead of swallowing them.
    name: 'excess-positional',
    layer: 'command-validation',
    weight: 6,
    code: 'INVALID_ARGS',
    apply: (base) => {
      if (base.surface.maxPositionals === null) return null;
      const filler = SAFE_VALUES[base.salt % SAFE_VALUES.length] || 'extra';
      const positionals = [
        ...Array.from({ length: base.surface.maxPositionals }, () => 'p'),
        ...Array.from({ length: 1 + (base.salt % 2) }, () => filler),
      ];
      return {
        payload: [base.surface.name, ...positionals],
        mutation: 'excess-positional',
      };
    },
  },
  flagMutation({
    name: 'unsupported-flag',
    layer: 'command-validation',
    weight: 6,
    code: 'INVALID_ARGS',
    // A foreign flag must also be a foreign *token*: `--port` is unsupported on `proxy` as the
    // metro key, but the parser resolves that token to proxy's own `--port` and accepts it, so the
    // case would assert a violation the parser never owed.
    candidates: (base) => {
      const ownTokens = new Set(base.surface.flags.map(flagToken));
      return safeFlagPool().filter(
        (definition) =>
          !isFlagSupportedForCommand(definition.key, base.surface.name) &&
          !ownTokens.has(flagToken(definition)),
      );
    },
    argv: (definition, base) => [...validArgv(base), renderFlag(definition, base.salt)],
  }),
  flagMutation({
    name: 'bad-enum-value',
    layer: 'token-scan',
    weight: 1,
    code: 'INVALID_ARGS',
    candidates: (base) => base.surface.flags.filter((definition) => definition.type === 'enum'),
    argv: (definition, base) => [
      base.surface.name,
      `${flagToken(definition)}=bogus-${base.salt % 7}`,
    ],
  }),
  flagMutation({
    name: 'int-out-of-range',
    layer: 'token-scan',
    weight: 1,
    code: 'INVALID_ARGS',
    candidates: (base) =>
      base.surface.flags.filter(
        (definition) =>
          (definition.type === 'int' || definition.type === 'number') &&
          (definition.min !== undefined || definition.max !== undefined),
      ),
    argv: (definition, base) => [
      base.surface.name,
      `${flagToken(definition)}=${definition.min !== undefined ? definition.min - 1 : definition.max! + 1}`,
    ],
  }),
  flagMutation({
    name: 'missing-flag-value',
    layer: 'token-scan',
    weight: 1,
    code: 'INVALID_ARGS',
    candidates: (base) => base.surface.flags.filter(isValueFlag),
    argv: (definition, base) => [base.surface.name, flagToken(definition)],
  }),
  flagMutation({
    name: 'boolean-with-value',
    layer: 'token-scan',
    weight: 1,
    code: 'INVALID_ARGS',
    candidates: (base) =>
      base.surface.flags.filter(
        (definition) => definition.type === 'boolean' || definition.setValue !== undefined,
      ),
    argv: (definition, base) => [...validArgv(base), `${flagToken(definition)}=true`],
  }),
  {
    name: 'unknown-command',
    layer: 'command-validation',
    weight: 3,
    code: 'INVALID_ARGS',
    apply: (base) => {
      const names = fakeCommands();
      const name = names[base.salt % names.length]!;
      return { payload: [name, ...base.positionals], mutation: 'unknown-command' };
    },
  },
];

/**
 * What the generator can emit at all: the commands it builds cases for and the flag keys those
 * commands can carry. Reachability rather than a sample, because a flag drawn about once per
 * 3,000 cases would make a coverage gate depend on seed luck instead of on the surface.
 */
export function generatableCliSurface(): { commands: string[]; flagKeys: string[] } {
  const surfaces = cliSurfaces();
  return {
    commands: surfaces.map((surface) => surface.name),
    flagKeys: [...new Set(surfaces.flatMap((surface) => surface.flags.map((flag) => flag.key)))],
  };
}

/** The classes this generator declares, so its coverage test needs no hand-kept list. */
export const CLI_MUTATION_NAMES: readonly string[] = CLI_MUTATIONS.map((mutation) => mutation.name);

const cliBaseArb: fc.Arbitrary<CliBase> = fc
  .record({
    surfaceIndex: fc.nat(),
    positionals: fc.array(fc.constantFrom(...SAFE_VALUES), { maxLength: 4 }),
    flagIndices: fc.uniqueArray(fc.nat({ max: 200 }), { maxLength: 3 }),
    salt: fc.nat({ max: 10_000 }),
  })
  .map(({ surfaceIndex, positionals, flagIndices, salt }) => {
    const surfaces = cliSurfaces();
    const surface = surfaces[surfaceIndex % surfaces.length]!;
    const maxPositionals = surface.maxPositionals ?? 3;
    const flags = [
      ...new Map(
        flagIndices
          .filter(() => surface.flags.length > 0)
          .map((index) => surface.flags[index % surface.flags.length]!)
          .map((definition) => [definition.key, definition]),
      ).values(),
    ];
    return { surface, positionals: positionals.slice(0, maxPositionals), flags, salt };
  });

/** Mutation indices expanded by weight, so command-validation classes take the larger share. */
const weightedCliMutations = memoize(() =>
  CLI_MUTATIONS.flatMap((mutation, index) => Array.from({ length: mutation.weight }, () => index)),
);

function validCase(base: CliBase): string {
  return encodeValidationCase({ payload: validArgv(base), mutation: 'valid', expect: ACCEPT });
}

/** Encoded CLI validation cases: ~1/4 valid (expect accept), the rest planted violations. */
export const cliValidationArb: fc.Arbitrary<string> = fc
  .record({ base: cliBaseArb, mutationIndex: fc.nat() })
  .map(({ base, mutationIndex }) => {
    const weighted = weightedCliMutations();
    // A quarter of the space stays valid so a false rejection is discoverable too.
    if (mutationIndex % (weighted.length + 6) >= weighted.length) return validCase(base);
    // Rotate to the first applicable mutation so the map stays total.
    for (let step = 0; step < weighted.length; step += 1) {
      const mutation = CLI_MUTATIONS[weighted[(mutationIndex + step) % weighted.length]!]!;
      const built = mutation.apply(base);
      if (built) {
        return encodeValidationCase({
          ...built,
          expect: { outcome: 'reject', code: mutation.code },
        });
      }
    }
    return validCase(base);
  });
