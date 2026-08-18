// Structured case generators for the validation fuzz targets (#1781 B2).
//
// The classic mutators splice hazards into flat strings, so a CLI or Maestro case almost always
// dies in the tokenizer ("Unknown command", YAML error) and the validation layer behind it goes
// unexercised. These generators build cases FROM the real command surface — the CLI schema
// registry and the Maestro command shapes — so a case tokenizes cleanly and its planted
// violation surfaces in command validation (positional arity, flag support, enum/range checks,
// unsupported Maestro commands and fields). Each case records the outcome it was built to have;
// validation-case.ts judges the parser against it, which is what makes a silent acceptance
// (the #1433 class) reportable at all.

import fc from 'fast-check';
import { isKnownCliCommandName, listCliCommandNames } from '../../src/command-catalog.ts';
import {
  getCliCommandSchema,
  getFlagDefinitions,
  type FlagDefinition,
} from '../../src/cli-schema/command-schema.ts';
import { isFlagSupportedForCommand } from '../../src/cli-schema/option-schema.ts';
import { encodeValidationCase, type ValidationCase } from './validation-case.ts';

const REJECT = { outcome: 'reject', code: 'INVALID_ARGS' } as const;
const ACCEPT = { outcome: 'accept' } as const;

// Benign, occasionally hostile positional/flag values. No leading '-': a dash token would be
// read as a flag and the case would die before validation, which is the classic targets' job.
const SAFE_VALUES = [
  'com.example.app',
  'text=Login',
  '@e1',
  'hello world',
  '123',
  'Ünïcøde',
  '😀 emoji',
  'say "hi"',
  'a\\b',
  '',
] as const;

// ---------------------------------------------------------------------------------------------
// CLI: the surface is derived from the schema registry, never hand-listed.
// ---------------------------------------------------------------------------------------------

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

const COLLIDING_FLAG_NAMES = collidingFlagNames(getFlagDefinitions());

/** Flag definitions with a single unambiguous long name, excluding the special keys. */
const SAFE_FLAG_POOL: readonly FlagDefinition[] = getFlagDefinitions().filter(
  (definition) =>
    !EXCLUDED_FLAG_KEYS.has(definition.key) &&
    definition.names.some((name) => name.startsWith('--') && !COLLIDING_FLAG_NAMES.has(name)),
);

function flagToken(definition: FlagDefinition): string {
  return definition.names.find(
    (name) => name.startsWith('--') && !COLLIDING_FLAG_NAMES.has(name),
  )!;
}

const CLI_SURFACES: readonly CliCommandSurface[] = listCliCommandNames()
  .filter((name) => !EXCLUDED_CLI_COMMANDS.has(name))
  .map((name) => {
    const schema = getCliCommandSchema(name);
    return {
      name,
      maxPositionals: schema.allowsExtraPositionals ? null : (schema.positionalArgs?.length ?? 0),
      flags: SAFE_FLAG_POOL.filter((definition) =>
        isFlagSupportedForCommand(definition.key, name),
      ),
    };
  });

/** A schema-valid value for one flag, salt-selected so shrinking stays deterministic. */
function validFlagValue(definition: FlagDefinition, salt: number): string {
  if (definition.type === 'enum') {
    const values = definition.enumValues ?? [];
    return values[salt % Math.max(values.length, 1)] ?? '1';
  }
  if (definition.type === 'int' || definition.type === 'number') {
    const low = definition.min ?? 0;
    const high = definition.max ?? low + 1000;
    return String(low + (salt % (high - low + 1)));
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

type CliMutation = {
  name: string;
  apply: (base: CliBase) => ValidationCase | null;
};

const isValueFlag = (definition: FlagDefinition) =>
  definition.setValue === undefined &&
  (definition.type === 'string' ||
    definition.type === 'enum' ||
    definition.type === 'int' ||
    definition.type === 'number');

const FAKE_COMMANDS = ['frobnicate', 'tapp', 'navigate', 'clik', 'snapshoot', 'opne'].filter(
  (name) => !isKnownCliCommandName(name),
);

const CLI_MUTATIONS: readonly CliMutation[] = [
  {
    // #1433: a bounded command must refuse extra positionals instead of swallowing them.
    name: 'excess-positional',
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
        expect: REJECT,
      };
    },
  },
  {
    name: 'unsupported-flag',
    apply: (base) => {
      const foreign = SAFE_FLAG_POOL.filter(
        (definition) => !isFlagSupportedForCommand(definition.key, base.surface.name),
      );
      const definition = foreign[base.salt % Math.max(foreign.length, 1)];
      if (!definition) return null;
      return {
        payload: [...validArgv(base), renderFlag(definition, base.salt)],
        mutation: 'unsupported-flag',
        expect: REJECT,
      };
    },
  },
  {
    name: 'bad-enum-value',
    apply: (base) => {
      const enums = base.surface.flags.filter((definition) => definition.type === 'enum');
      const definition = enums[base.salt % Math.max(enums.length, 1)];
      if (!definition) return null;
      return {
        payload: [base.surface.name, `${flagToken(definition)}=bogus-${base.salt % 7}`],
        mutation: 'bad-enum-value',
        expect: REJECT,
      };
    },
  },
  {
    name: 'int-out-of-range',
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
        expect: REJECT,
      };
    },
  },
  {
    name: 'missing-flag-value',
    apply: (base) => {
      const valued = base.surface.flags.filter(isValueFlag);
      const definition = valued[base.salt % Math.max(valued.length, 1)];
      if (!definition) return null;
      return {
        payload: [base.surface.name, flagToken(definition)],
        mutation: 'missing-flag-value',
        expect: REJECT,
      };
    },
  },
  {
    name: 'boolean-with-value',
    apply: (base) => {
      const booleans = base.surface.flags.filter(
        (definition) => definition.type === 'boolean' || definition.setValue !== undefined,
      );
      const definition = booleans[base.salt % Math.max(booleans.length, 1)];
      if (!definition) return null;
      return {
        payload: [...validArgv(base), `${flagToken(definition)}=true`],
        mutation: 'boolean-with-value',
        expect: REJECT,
      };
    },
  },
  {
    name: 'unknown-command',
    apply: (base) => {
      const name = FAKE_COMMANDS[base.salt % FAKE_COMMANDS.length]!;
      return { payload: [name, ...base.positionals], mutation: 'unknown-command', expect: REJECT };
    },
  },
  {
    name: 'batch-step-source',
    apply: (base) => ({
      payload:
        base.salt % 2 === 0 ? ['batch'] : ['batch', '--steps=[]', '--steps-file=steps.json'],
      mutation: 'batch-step-source',
      expect: REJECT,
    }),
  },
  {
    name: 'back-mode-conflict',
    apply: () => ({
      payload: ['back', '--in-app', '--system'],
      mutation: 'back-mode-conflict',
      expect: REJECT,
    }),
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
    const surface = CLI_SURFACES[surfaceIndex % CLI_SURFACES.length]!;
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

/** Encoded CLI validation cases: ~1/3 valid (expect accept), the rest planted violations. */
export const cliValidationArb: fc.Arbitrary<string> = fc
  .record({ base: cliBaseArb, mutationIndex: fc.nat() })
  .map(({ base, mutationIndex }) => {
    // A third of the space stays valid so a false rejection is discoverable too.
    if (mutationIndex % (CLI_MUTATIONS.length + 4) >= CLI_MUTATIONS.length) {
      return encodeValidationCase({ payload: validArgv(base), mutation: 'valid', expect: ACCEPT });
    }
    // Rotate to the first applicable mutation so the map stays total.
    for (let step = 0; step < CLI_MUTATIONS.length; step += 1) {
      const mutation = CLI_MUTATIONS[(mutationIndex + step) % CLI_MUTATIONS.length]!;
      const validationCase = mutation.apply(base);
      if (validationCase) return encodeValidationCase(validationCase);
    }
    return encodeValidationCase({ payload: validArgv(base), mutation: 'valid', expect: ACCEPT });
  });

// ---------------------------------------------------------------------------------------------
// Maestro: cases are built from the command shapes the converter accepts, then one shape rule
// is violated. The soundness test replays samples against the real parser, so a drifted shape
// fails at PR time rather than as a phantom nightly finding.
// ---------------------------------------------------------------------------------------------

const yamlText = (salt: number): string =>
  JSON.stringify(SAFE_VALUES[salt % SAFE_VALUES.length] || 'Login');

/** One valid command rendered as YAML list-entry lines. */
function validMaestroCommand(pick: number, salt: number): string[] {
  const text = yamlText(salt);
  const options: (() => string[])[] = [
    () => ['- back'],
    () => ['- hideKeyboard'],
    () => ['- stopApp'],
    () => ['- scroll'],
    () => ['- waitForAnimationToEnd'],
    () => ['- launchApp'],
    () => [`- launchApp: ${text}`],
    () => [`- tapOn: ${text}`],
    () => ['- tapOn:', `    id: ${text}`],
    () => ['- tapOn:', `    text: ${text}`],
    () => [`- doubleTapOn: ${text}`],
    () => [`- longPressOn: ${text}`],
    () => [`- inputText: ${text}`],
    () => ['- openLink: "https://example.com/page"'],
    () => [`- assertVisible: ${text}`],
    () => [`- assertNotVisible: ${text}`],
    () => [`- takeScreenshot: ${text}`],
    () => ['- swipe:', `    direction: ${['UP', 'DOWN', 'LEFT', 'RIGHT'][salt % 4]}`],
    () => [`- pressKey: ${['back', 'enter', 'return', 'home'][salt % 4]}`],
    () => ['- extendedWaitUntil:', `    visible: ${text}`, '    timeout: 500'],
    () => ['- scrollUntilVisible:', '    element:', `        text: ${text}`],
    () => ['- repeat:', '    times: 2', '    commands:', '      - back'],
    () => ['- runFlow: other.yaml'],
  ];
  return options[pick % options.length]!();
}

const FAKE_MAESTRO_COMMANDS = [
  'clickOn',
  'tapOnPoint',
  'assertTrue',
  'evalScript',
  'launchActivity',
  'inputTextt',
] as const;

type MaestroMutation = { name: string; lines: (salt: number) => string[] };

const MAESTRO_MUTATIONS: readonly MaestroMutation[] = [
  {
    // The B2 headline: an unknown command name must die in command validation, not the
    // YAML tokenizer — mutated names used to be unreachable because the YAML never parsed.
    name: 'unsupported-command',
    lines: (salt) => {
      const name = FAKE_MAESTRO_COMMANDS[salt % FAKE_MAESTRO_COMMANDS.length]!;
      return salt % 2 === 0 ? [`- ${name}`] : [`- ${name}: ${yamlText(salt)}`];
    },
  },
  {
    name: 'unsupported-field',
    lines: (salt) =>
      salt % 2 === 0
        ? ['- tapOn:', `    bogusField: ${yamlText(salt)}`]
        : ['- launchApp:', `    appId: ${yamlText(salt)}`, '    bogus: 1'],
  },
  {
    name: 'multi-key-command',
    lines: (salt) => [`- tapOn: ${yamlText(salt)}`, `  inputText: ${yamlText(salt + 1)}`],
  },
  {
    name: 'missing-required',
    lines: (salt) =>
      salt % 2 === 0 ? ['- inputText:'] : ['- extendedWaitUntil:', '    timeout: 500'],
  },
  { name: 'bad-press-key', lines: () => ['- pressKey: sleep'] },
  { name: 'scroll-options', lines: () => ['- scroll:', '    direction: UP'] },
];

type MaestroBase = { commandPicks: number[]; salt: number; withConfig: boolean };

function renderMaestroFlow(base: MaestroBase, mutatedLines?: string[], at?: number): string {
  const commands = base.commandPicks.map((pick, index) =>
    validMaestroCommand(pick, base.salt + index),
  );
  if (mutatedLines) commands.splice(Math.min(at ?? 0, commands.length), 0, mutatedLines);
  const body = commands.flat().join('\n');
  const config = base.withConfig ? `appId: ${yamlText(base.salt)}\n---\n` : '';
  return `${config}${body}\n`;
}

const maestroBaseArb: fc.Arbitrary<MaestroBase> = fc.record({
  commandPicks: fc.array(fc.nat({ max: 100 }), { minLength: 1, maxLength: 4 }),
  salt: fc.nat({ max: 10_000 }),
  withConfig: fc.boolean(),
});

/** Encoded Maestro validation cases: ~1/3 valid flows, the rest one planted shape violation. */
export const maestroValidationArb: fc.Arbitrary<string> = fc
  .record({ base: maestroBaseArb, mutationIndex: fc.nat(), insertAt: fc.nat({ max: 4 }) })
  .map(({ base, mutationIndex, insertAt }) => {
    if (mutationIndex % (MAESTRO_MUTATIONS.length + 3) >= MAESTRO_MUTATIONS.length) {
      return encodeValidationCase({
        payload: renderMaestroFlow(base),
        mutation: 'valid',
        expect: ACCEPT,
      });
    }
    const mutation = MAESTRO_MUTATIONS[mutationIndex % MAESTRO_MUTATIONS.length]!;
    // A config-level violation replaces the flow body mutation for a slice of the space.
    if (mutation.name === 'unsupported-field' && base.salt % 3 === 0) {
      return encodeValidationCase({
        payload: `appId: com.example.app\nbogusKey: 1\n---\n${renderMaestroFlow({ ...base, withConfig: false })}`,
        mutation: 'config-unknown-key',
        expect: REJECT,
      });
    }
    return encodeValidationCase({
      payload: renderMaestroFlow(base, mutation.lines(base.salt), insertAt),
      mutation: mutation.name,
      expect: REJECT,
    });
  });
