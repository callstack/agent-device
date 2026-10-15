import { formatRef, refArb } from '@agent-device/test-kit';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { SCROLL_DIRECTIONS, SWIPE_PRESETS } from '@agent-device/contracts/scroll-gesture';
import fc from 'fast-check';

const scriptTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('Submit', 'Log in', 'a "quoted" label', "it's fine", 'tab\tseparated', 'Ünïcøde'),
  fc.string({ minLength: 1, maxLength: 10 }),
);

const scriptTargetArb: fc.Arbitrary<string> = fc.oneof(
  refArb.map(formatRef),
  scriptTextArb.map((text) => JSON.stringify(`label=${text}`)),
  // #3197: a hand-written line quotes a selector with single quotes the way the
  // shell does. The formatter always rewrites to the JSON spelling, so this tests
  // the tokenizer's reading without expecting the single-quote form back.
  fc.constantFrom('Sign in', 'Log in', 'Submit').map((label) => `'label=${JSON.stringify(label)}'`),
);

const coordinateArb = fc.integer({ min: 0, max: 1200 }).map(String);

/**
 * The `wait` line tails the script grammar accepts after the target: its budget
 * positional, and the capture-scope flags it declares (#3197). Both may appear on
 * one line, positional before flags, which is the order the writer emits them in.
 */
const WAIT_TIMEOUT_ARB: fc.Arbitrary<string> = fc
  .integer({ min: 100, max: 5000 })
  .map((timeout) => ` ${timeout}`);

const WAIT_CAPTURE_FLAG_ARB: fc.Arbitrary<string> = fc.oneof(
  fc.constant(' --raw'),
  fc.integer({ min: 0, max: 6 }).map((depth) => ` --depth ${depth}`),
  scriptTextArb.map((scope) => ` --scope ${JSON.stringify(scope)}`),
);

/** The `scroll` flags the script grammar carries (#3197): the stop condition. */
const SCROLL_FLAG_ARB: fc.Arbitrary<string> = scriptTargetArb.map((target) => ` --until ${target}`);

/**
 * A command is either generated from a line template or explicitly waived with
 * the reason it needs none. `Record<PublicCommandName, …>` makes the
 * classification exhaustive: a new public command does not compile until it is
 * given a template or a waiver.
 */
/**
 * Every command name a `.ad` line can carry. Internal commands are included
 * because scripts record them too (`runtime` has its own parse/print branch).
 */
type ReplayCommandName =
  | (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS]
  | (typeof INTERNAL_COMMANDS)[keyof typeof INTERNAL_COMMANDS];

type ReplayLinePlan = fc.Arbitrary<string> | { waived: string };

/**
 * Commands whose `.ad` line is a bare `<command> <token>…` handled by the
 * generic parse/print branch (`appendGenericActionScriptArgs`), whose shape the
 * `wait`/`longpress` templates already exercise. A command that grows its own
 * branch in the replay command's script formatting must move to a template.
 */
const GENERIC_REPLAY_LINE = {
  waived: 'generic line shape, covered by the wait/longpress templates',
} as const;

const REPLAY_SCRIPT_LINE_PLANS = {
  click: fc.oneof(
    scriptTargetArb.map((target) => `click ${target}`),
    fc.tuple(coordinateArb, coordinateArb).map(([x, y]) => `click ${x} ${y}`),
    fc
      .tuple(scriptTargetArb, fc.integer({ min: 1, max: 5 }))
      .map(([target, count]) => `click ${target} --count ${count}`),
  ),
  press: fc.oneof(
    scriptTargetArb.map((target) => `press ${target}`),
    fc
      .tuple(scriptTargetArb, fc.constantFrom('primary', 'secondary', 'middle'))
      .map(([target, button]) => `press ${target} --button ${button}`),
  ),
  longpress: scriptTargetArb.map((target) => `longpress ${target}`),
  hover: scriptTargetArb.map((target) => `hover ${target}`),
  wait: fc
    .tuple(
      scriptTargetArb,
      fc.option(WAIT_TIMEOUT_ARB, { nil: '' }),
      fc.option(WAIT_CAPTURE_FLAG_ARB, { nil: '' }),
    )
    .map(([target, timeout, capture]) => `wait ${target}${timeout}${capture}`),
  fill: fc
    .tuple(scriptTargetArb, scriptTextArb)
    .map(([target, text]) => `fill ${target} ${JSON.stringify(text)}`),
  type: scriptTextArb.map((text) => `type ${JSON.stringify(text)}`),
  get: fc
    .tuple(fc.constantFrom('text', 'value', 'label'), scriptTargetArb)
    .map(([property, target]) => `get ${property} ${target}`),
  swipe: fc
    .tuple(coordinateArb, coordinateArb, coordinateArb, coordinateArb)
    .map((coordinates) => `swipe ${coordinates.join(' ')}`),
  gesture: fc.oneof(
    fc
      .tuple(coordinateArb, coordinateArb, coordinateArb, coordinateArb)
      .map((coordinates) => `gesture pan ${coordinates.join(' ')}`),
    fc
      .tuple(fc.constantFrom(...SCROLL_DIRECTIONS), coordinateArb, coordinateArb)
      .map(([direction, x, y]) => `gesture fling ${direction} ${x} ${y}`),
    fc.constantFrom(...SWIPE_PRESETS).map((preset) => `gesture swipe ${preset}`),
    fc.integer({ min: -180, max: 180 }).map((degrees) => `gesture rotate ${degrees}`),
  ),
  snapshot: fc.oneof(
    fc.constant('snapshot'),
    fc.constant('snapshot -i'),
    fc.integer({ min: 0, max: 6 }).map((depth) => `snapshot -d ${depth}`),
    scriptTextArb.map((scope) => `snapshot -s ${JSON.stringify(scope)}`),
  ),
  screenshot: fc.constantFrom('screenshot', 'screenshot out.png'),
  open: fc.oneof(
    fc.constantFrom('open com.example.app', 'open com.example.app --relaunch'),
    fc
      .tuple(fc.constantFrom('ios', 'android'), fc.integer({ min: 1, max: 65_535 }))
      .map(
        ([platform, port]) => `open com.example.app --platform ${platform} --metro-port ${port}`,
      ),
  ),
  runtime: fc.oneof(
    fc.constant('runtime metro'),
    fc.constantFrom('ios', 'android').map((platform) => `runtime metro --platform ${platform}`),
  ),
  record: fc.oneof(
    fc.constantFrom('record start', 'record stop', 'record start --hide-touches'),
    fc.integer({ min: 1, max: 120 }).map((fps) => `record start --fps ${fps}`),
  ),
  alert: GENERIC_REPLAY_LINE,
  'app-switcher': GENERIC_REPLAY_LINE,
  'action-button': GENERIC_REPLAY_LINE,
  fold: GENERIC_REPLAY_LINE,
  telephony: GENERIC_REPLAY_LINE,
  apps: GENERIC_REPLAY_LINE,
  appstate: GENERIC_REPLAY_LINE,
  artifacts: GENERIC_REPLAY_LINE,
  audio: GENERIC_REPLAY_LINE,
  back: GENERIC_REPLAY_LINE,
  batch: GENERIC_REPLAY_LINE,
  boot: GENERIC_REPLAY_LINE,
  capabilities: GENERIC_REPLAY_LINE,
  clipboard: GENERIC_REPLAY_LINE,
  close: GENERIC_REPLAY_LINE,
  devices: GENERIC_REPLAY_LINE,
  diff: GENERIC_REPLAY_LINE,
  doctor: GENERIC_REPLAY_LINE,
  events: GENERIC_REPLAY_LINE,
  find: GENERIC_REPLAY_LINE,
  focus: GENERIC_REPLAY_LINE,
  home: GENERIC_REPLAY_LINE,
  install: GENERIC_REPLAY_LINE,
  'install-from-source': GENERIC_REPLAY_LINE,
  is: GENERIC_REPLAY_LINE,
  keyboard: GENERIC_REPLAY_LINE,
  logs: GENERIC_REPLAY_LINE,
  network: GENERIC_REPLAY_LINE,
  orientation: GENERIC_REPLAY_LINE,
  perf: GENERIC_REPLAY_LINE,
  prepare: GENERIC_REPLAY_LINE,
  push: GENERIC_REPLAY_LINE,
  'react-native': GENERIC_REPLAY_LINE,
  reinstall: GENERIC_REPLAY_LINE,
  replay: GENERIC_REPLAY_LINE,
  scroll: fc
    .tuple(
      fc.constantFrom(...SCROLL_DIRECTIONS),
      fc.option(fc.constantFrom('0.5', '0.8'), { nil: undefined }),
      fc.option(SCROLL_FLAG_ARB, { nil: undefined }),
    )
    .map(
      ([direction, amount, flags]) =>
        `scroll ${direction}${amount === undefined ? '' : ` ${amount}`}${flags ?? ''}`,
    ),
  settings: GENERIC_REPLAY_LINE,
  shutdown: GENERIC_REPLAY_LINE,
  test: GENERIC_REPLAY_LINE,
  trace: GENERIC_REPLAY_LINE,
  'trigger-app-event': GENERIC_REPLAY_LINE,
  'tv-remote': GENERIC_REPLAY_LINE,
  uninstall: GENERIC_REPLAY_LINE,
  viewport: GENERIC_REPLAY_LINE,
  human_control: { waived: 'host-local control commands are never recorded in replay scripts' },
  install_source: GENERIC_REPLAY_LINE,
  lease_allocate: GENERIC_REPLAY_LINE,
  lease_heartbeat: GENERIC_REPLAY_LINE,
  lease_release: GENERIC_REPLAY_LINE,
  release_materialized_paths: GENERIC_REPLAY_LINE,
  session_list: GENERIC_REPLAY_LINE,
  session_save_script: GENERIC_REPLAY_LINE,
} satisfies Record<ReplayCommandName, ReplayLinePlan>;

/**
 * Line templates for every command, resolved through the runtime command
 * catalog so a command that exists at runtime but not in the plan fails loudly.
 */
function replayScriptLineArbs(): fc.Arbitrary<string>[] {
  const arbitraries: fc.Arbitrary<string>[] = [];
  const commands: ReplayCommandName[] = [
    ...Object.values(PUBLIC_COMMANDS),
    ...Object.values(INTERNAL_COMMANDS),
  ];
  for (const command of commands) {
    const plan: ReplayLinePlan | undefined = REPLAY_SCRIPT_LINE_PLANS[command];
    if (plan === undefined) {
      throw new Error(
        `replay command "${command}" from @agent-device/command-registry/catalog is ` +
          'unclassified: ' +
          'add a line template or a waiver to REPLAY_SCRIPT_LINE_PLANS in ' +
          'src/commands/replay/replay-script.fixtures.ts',
      );
    }
    if (!('waived' in plan)) arbitraries.push(plan);
  }
  return arbitraries;
}

const replayScriptLineArb: fc.Arbitrary<string> = fc.oneof(...replayScriptLineArbs());

/** A valid `.ad` script: action lines interleaved with comments and blank lines. */
export const replayScriptArb: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { weight: 8, arbitrary: replayScriptLineArb },
      { weight: 1, arbitrary: fc.constantFrom('# a comment', '') },
    ),
    { minLength: 1, maxLength: 8 },
  )
  .map((lines) => `${lines.join('\n')}\n`);
