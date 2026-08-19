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

// Commands whose parse path is deliberately special: cdp preserves post-command args verbatim,
// react-devtools passes unknown flags through, batch enforces a step-source invariant covered
// by its own fixed mutation below.
const EXCLUDED_CLI_COMMANDS = new Set(['cdp', 'react-devtools', 'batch']);

// help/version reroute parsing, snapshotDiff rewrites the command, steps/stepsFile carry the
// batch step-source invariant. All are exercised elsewhere; here they would blur expectations.
const EXCLUDED_FLAG_KEYS = new Set(['help', 'version', 'snapshotDiff', 'steps', 'stepsFile']);

function collidingFlagNames(definitions: readonly FlagDefinition[]): Set<string> {
  const counts = new Map<string, number>();
  for (const definition of definitions) {
    for (const name of definition.names) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name));
}

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

const collidingNames = memoize(() => collidingFlagNames(getFlagDefinitions()));

/** Flag definitions with a single unambiguous long name, excluding the special keys. */
const safeFlagPool = memoize<readonly FlagDefinition[]>(() =>
  getFlagDefinitions().filter(
    (definition) =>
      !EXCLUDED_FLAG_KEYS.has(definition.key) &&
      definition.names.some((name) => name.startsWith('--') && !collidingNames().has(name)),
  ),
);

function flagToken(definition: FlagDefinition): string {
  return definition.names.find((name) => name.startsWith('--') && !collidingNames().has(name))!;
}

const cliSurfaces = memoize<readonly CliCommandSurface[]>(() => {
  surfaceBuilds += 1;
  return listCliCommandNames()
    .filter((name) => !EXCLUDED_CLI_COMMANDS.has(name))
    .map((name) => {
      const schema = getCliCommandSchema(name);
      return {
        name,
        maxPositionals: schema.allowsExtraPositionals ? null : (schema.positionalArgs?.length ?? 0),
        flags: safeFlagPool().filter((definition) =>
          isFlagSupportedForCommand(definition.key, name),
        ),
      };
    });
});

/** Inclusive bounds for a numeric flag, defaulted when the schema leaves an end open. */
function numericBounds(definition: FlagDefinition): { low: number; high: number } {
  const low = definition.min ?? 0;
  return { low, high: definition.max ?? low + 1000 };
}

/**
 * A schema-valid numeric value. Floats take endpoints and the midpoint only: modulo arithmetic
 * can drift past a fractional `max` (a 33k-case slice produced `--scale=1.110000000000017`,
 * which the parser rightly rejected — a phantom finding, not a bug).
 */
function validNumericValue(definition: FlagDefinition, salt: number): string {
  const { low, high } = numericBounds(definition);
  if (definition.type === 'int') return String(low + (salt % (high - low + 1)));
  return String([low, high, (low + high) / 2][salt % 3]);
}

/** A schema-valid value for one flag, salt-selected so shrinking stays deterministic. */
function validFlagValue(definition: FlagDefinition, salt: number): string {
  if (definition.type === 'enum') {
    const values = definition.enumValues ?? [];
    return values[salt % Math.max(values.length, 1)] ?? '1';
  }
  if (definition.type === 'int' || definition.type === 'number') {
    return validNumericValue(definition, salt);
  }
  const value = SAFE_VALUES[salt % SAFE_VALUES.length]!;
  return value.length === 0 ? 'value' : value;
}

/** Renders one flag as argv tokens; value flags use `--flag=value` so no token is consumed. */
function renderFlag(definition: FlagDefinition, salt: number): string {
  const token = flagToken(definition);
  if (definition.type === 'boolean' || definition.setValue !== undefined) return token;
  if (definition.type === 'booleanOrString') return token;
  return `${token}=${validFlagValue(definition, salt)}`;
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
  {
    name: 'unsupported-flag',
    layer: 'command-validation',
    weight: 6,
    code: 'INVALID_ARGS',
    apply: (base) => {
      const foreign = safeFlagPool().filter(
        (definition) => !isFlagSupportedForCommand(definition.key, base.surface.name),
      );
      const definition = foreign[base.salt % Math.max(foreign.length, 1)];
      if (!definition) return null;
      return {
        payload: [...validArgv(base), renderFlag(definition, base.salt)],
        mutation: 'unsupported-flag',
      };
    },
  },
  {
    name: 'bad-enum-value',
    layer: 'token-scan',
    weight: 1,
    code: 'INVALID_ARGS',
    apply: (base) => {
      const enums = base.surface.flags.filter((definition) => definition.type === 'enum');
      const definition = enums[base.salt % Math.max(enums.length, 1)];
      if (!definition) return null;
      return {
        payload: [base.surface.name, `${flagToken(definition)}=bogus-${base.salt % 7}`],
        mutation: 'bad-enum-value',
      };
    },
  },
  {
    name: 'int-out-of-range',
    layer: 'token-scan',
    weight: 1,
    code: 'INVALID_ARGS',
    apply: (base) => {
      const bounded = base.surface.flags.filter(
        (definition) =>
          (definition.type === 'int' || definition.type === 'number') &&
          (definition.min !== undefined || definition.max !== undefined),
      );
      const definition = bounded[base.salt % Math.max(bounded.length, 1)];
      if (!definition) return null;
      const value =
        definition.min !== undefined ? String(definition.min - 1) : String(definition.max! + 1);
      return {
        payload: [base.surface.name, `${flagToken(definition)}=${value}`],
        mutation: 'int-out-of-range',
      };
    },
  },
  {
    name: 'missing-flag-value',
    layer: 'token-scan',
    weight: 1,
    code: 'INVALID_ARGS',
    apply: (base) => {
      const valued = base.surface.flags.filter(isValueFlag);
      const definition = valued[base.salt % Math.max(valued.length, 1)];
      if (!definition) return null;
      return {
        payload: [base.surface.name, flagToken(definition)],
        mutation: 'missing-flag-value',
      };
    },
  },
  {
    name: 'boolean-with-value',
    layer: 'token-scan',
    weight: 1,
    code: 'INVALID_ARGS',
    apply: (base) => {
      const booleans = base.surface.flags.filter(
        (definition) => definition.type === 'boolean' || definition.setValue !== undefined,
      );
      const definition = booleans[base.salt % Math.max(booleans.length, 1)];
      if (!definition) return null;
      return {
        payload: [...validArgv(base), `${flagToken(definition)}=true`],
        mutation: 'boolean-with-value',
      };
    },
  },
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
