// Maestro flow case generation for the `maestro-validation` fuzz target (#1781 B2).
//
// Cases are built from the command shapes the converter accepts, then one shape rule is violated,
// so the failure surfaces in command-shape validation rather than in the YAML tokenizer. The
// shapes are rendered here rather than derived from a registry — Maestro's accepted surface is a
// parser table, not exported data — so the generator test replays samples against the real parser
// and a drifted shape fails at PR time instead of phantoming nightly.

import fc from 'fast-check';
import { encodeValidationCase } from './validation-case.ts';
import { ACCEPT, SAFE_VALUES } from './validation-values.ts';

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

/** `code` is per class, like the CLI table: a class whose contract changes moves alone. */
type MaestroMutation = { name: string; code: string; lines: (salt: number) => string[] };

const MAESTRO_MUTATIONS: readonly MaestroMutation[] = [
  {
    // The B2 headline: an unknown command name must die in command validation, not the
    // YAML tokenizer — mutated names used to be unreachable because the YAML never parsed.
    name: 'unsupported-command',
    code: 'INVALID_ARGS',
    lines: (salt) => {
      const name = FAKE_MAESTRO_COMMANDS[salt % FAKE_MAESTRO_COMMANDS.length]!;
      return salt % 2 === 0 ? [`- ${name}`] : [`- ${name}: ${yamlText(salt)}`];
    },
  },
  {
    name: 'unsupported-field',
    code: 'INVALID_ARGS',
    lines: (salt) =>
      salt % 2 === 0
        ? ['- tapOn:', `    bogusField: ${yamlText(salt)}`]
        : ['- launchApp:', `    appId: ${yamlText(salt)}`, '    bogus: 1'],
  },
  {
    name: 'multi-key-command',
    code: 'INVALID_ARGS',
    lines: (salt) => [`- tapOn: ${yamlText(salt)}`, `  inputText: ${yamlText(salt + 1)}`],
  },
  {
    name: 'missing-required',
    code: 'INVALID_ARGS',
    lines: (salt) =>
      salt % 2 === 0 ? ['- inputText:'] : ['- extendedWaitUntil:', '    timeout: 500'],
  },
  { name: 'bad-press-key', code: 'INVALID_ARGS', lines: () => ['- pressKey: sleep'] },
  { name: 'scroll-options', code: 'INVALID_ARGS', lines: () => ['- scroll:', '    direction: UP'] },
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
        expect: { outcome: 'reject', code: 'INVALID_ARGS' },
      });
    }
    return encodeValidationCase({
      payload: renderMaestroFlow(base, mutation.lines(base.salt), insertAt),
      mutation: mutation.name,
      expect: { outcome: 'reject', code: mutation.code },
    });
  });
