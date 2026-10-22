import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type {
  SnapshotPreferredBackend,
  SnapshotQualityVerdict,
} from '@agent-device/kernel/snapshot';
import type { SnapshotFacts } from './types.ts';

/** Routes `trigger-app-event` into the fixture's automation screen. */
export const FIXTURE_APP_EVENT_URL_TEMPLATE =
  'agent-device-test-app:///automation?event={event}&payload={payload}';

export type PublicCommand = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];

const C = PUBLIC_COMMANDS;

type Cli = readonly string[];

/**
 * One timed command. `args` tokens expand before each run: `{app}` is the fixture bundle id,
 * `{out:<file>}` a path in the run's artifact directory, and `{ref:<id>}` / `{point:<id>}` the ref
 * or center point of the element with that identifier in an untimed `snapshot -i` taken just
 * before the step. `before` and `after` run untimed around the step in every round.
 */
export type SuiteStep = {
  id: string;
  command: PublicCommand;
  args: Cli;
  before?: readonly Cli[];
  after?: readonly Cli[];
  // `sdk-forced-tree` captures a snapshot through the daemon with the XCTest tree backend pinned;
  // the CLI has no flag for it.
  via?: 'cli' | 'sdk-forced-tree';
  // A sample that succeeds but breaks the expectation fails with `expectation_failed`, so a
  // fixture that stops reproducing its shape shows up as a new failure.
  expect?: StepExpectation;
};

export type StepExpectation = {
  // Deepest raw node depth, counted from the application at 0.
  maxDepthAtLeast?: number;
  // The pinned backend that must serve the capture. The runner marks a pinned capture with the
  // reason code `requested-backend`; any other backend or code means the pin was not honored.
  pinnedBackend?: SnapshotPreferredBackend;
};

const PINNED_REASON_CODE: SnapshotQualityVerdict['reasonCode'] = 'requested-backend';

/** Describes how a snapshot breaks the step expectation, or returns undefined. */
export function expectationViolation(
  expect: StepExpectation | undefined,
  snapshot: SnapshotFacts | undefined,
): string | undefined {
  if (!expect) return undefined;
  if (expect.maxDepthAtLeast !== undefined && (snapshot?.maxDepth ?? -1) < expect.maxDepthAtLeast) {
    return `max depth ${snapshot?.maxDepth ?? 'unknown'} is below ${expect.maxDepthAtLeast}`;
  }
  if (
    expect.pinnedBackend !== undefined &&
    (snapshot?.backend !== expect.pinnedBackend || snapshot.reasonCode !== PINNED_REASON_CODE)
  ) {
    return `the ${snapshot?.backend ?? 'unknown'} backend (${snapshot?.reasonCode ?? 'no reason code'}) served the capture, not the pinned ${expect.pinnedBackend}`;
  }
  return undefined;
}

/** A scenario starts from `setup` (untimed, every round) and runs its steps in order. */
export type SuiteScenario = {
  id: string;
  title: string;
  setup: readonly Cli[];
  steps: SuiteStep[];
};

// A cold relaunch on a hosted runner can take longer than 15 s before the first landmark.
const LANDMARK_WAIT_MS = '60000';
const relaunch: Cli = ['open', '{app}', '--relaunch'];
const toTab = (label: string, landmark: string): Cli[] => [
  relaunch,
  ['wait', `label="${label}"`, LANDMARK_WAIT_MS],
  ['click', `label="${label}"`],
  ['wait', landmark, LANDMARK_WAIT_MS],
];
const toSettingsLab = (button: string, landmark: string): Cli[] => [
  ...toTab('Settings', 'id="settings-title"'),
  ['scroll', 'down', '--until', `id="${button}"`],
  ['click', `id="${button}"`],
  ['wait', landmark, LANDMARK_WAIT_MS],
];
const step = (
  id: string,
  command: PublicCommand,
  args: Cli,
  extra: Omit<SuiteStep, 'id' | 'command' | 'args'> = {},
): SuiteStep => ({ id, command, args, ...extra });

export const IOS_SUITE: readonly SuiteScenario[] = [
  {
    id: 'lifecycle',
    title: 'App lifecycle, device state, and inventory',
    setup: [relaunch, ['wait', 'text', 'Agent Device Tester', LANDMARK_WAIT_MS]],
    steps: [
      step('open-relaunch', C.open, relaunch),
      step('appstate', C.appState, ['appstate']),
      step('home', C.home, ['home']),
      step('open-resume', C.open, ['open', '{app}']),
      step('app-switcher', C.appSwitcher, ['app-switcher'], { after: [['open', '{app}']] }),
      step('orientation-landscape', C.orientation, ['orientation', 'landscape-left']),
      step('orientation-portrait', C.orientation, ['orientation', 'portrait']),
      step('settings-appearance', C.settings, ['settings', 'appearance', 'light']),
      step('clipboard-write', C.clipboard, ['clipboard', 'write', 'agent-device perf']),
      step('clipboard-read', C.clipboard, ['clipboard', 'read']),
      step('action-button', C.actionButton, ['action-button']),
      step('prepare-runner', C.prepare, ['prepare', 'ios-runner']),
      step('devices', C.devices, ['devices', '--platform', 'ios']),
      step('apps', C.apps, ['apps']),
      step('capabilities', C.capabilities, ['capabilities']),
      step('doctor', C.doctor, ['doctor']),
      // Some runtimes ask "Open in Agent Device Tester?" for the event URL, and the prompt outlives a
      // relaunch. The answer opens the URL seconds later, so wait for its route before the next
      // relaunch. The untimed calls stop at alert get when no prompt is up.
      step(
        'trigger-app-event',
        C.triggerAppEvent,
        ['trigger-app-event', 'fixture.ready', '{"source":"perf"}'],
        {
          after: [
            ['alert', 'get'],
            ['alert', 'accept'],
            ['wait', 'id="automation-title"', LANDMARK_WAIT_MS],
          ],
        },
      ),
    ],
  },
  {
    id: 'home-reads',
    title: 'Reads on the home screen (light tree)',
    setup: [relaunch, ['wait', 'text', 'Agent Device Tester', LANDMARK_WAIT_MS]],
    steps: [
      step('snapshot-i', C.snapshot, ['snapshot', '-i']),
      step('snapshot', C.snapshot, ['snapshot']),
      step('snapshot-raw', C.snapshot, ['snapshot', '--raw']),
      // Only the regular capture plan honors the pin; the raw plan runs its own backend ladder. The
      // XCTest tree rejects the heavy feed, so the pinned capture runs on this light screen.
      step('snapshot-forced-tree', C.snapshot, ['snapshot'], {
        via: 'sdk-forced-tree',
        expect: { pinnedBackend: 'tree' },
      }),
      step('snapshot-diff', C.snapshot, ['snapshot', '--diff']),
      step('diff-snapshot', C.diff, ['diff', 'snapshot']),
      step('wait-text', C.wait, ['wait', 'text', 'Agent Device Tester']),
      step('wait-selector', C.wait, ['wait', 'id="gesture-canary-ready"']),
      step('wait-absent', C.wait, ['wait', 'absent', 'id="heavy-feed-title"']),
      step('wait-stable', C.wait, ['wait', 'stable', '300', '5000']),
      step('is-visible', C.is, ['is', 'visible', 'id="gesture-canary-ready"']),
      step('is-exists', C.is, ['is', 'exists', 'text="Gesture lab"']),
      step('get-text', C.get, ['get', 'text', 'id="gesture-fling-status"']),
      step('get-attrs', C.get, ['get', 'attrs', 'id="drag-source"']),
      step('find-text', C.find, ['find', 'text', 'Gesture lab', 'exists']),
      step('batch-reads', C.batch, [
        'batch',
        '--steps',
        JSON.stringify([
          {
            command: 'get',
            input: {
              format: 'text',
              target: { kind: 'selector', selector: 'id="gesture-fling-status"' },
            },
          },
          { command: 'is', input: { predicate: 'visible', selector: 'id="gesture-canary-ready"' } },
        ]),
      ]),
      step('gesture-pan', C.gesture, [
        'gesture',
        'pan',
        '{point:gesture-target}',
        '40',
        '0',
        '300',
      ]),
      step('gesture-pinch', C.gesture, ['gesture', 'pinch', '1.4', '{point:gesture-target}']),
      step('screenshot', C.screenshot, ['screenshot', '{out:home.png}']),
      step('screenshot-overlay', C.screenshot, [
        'screenshot',
        '{out:home-refs.png}',
        '--overlay-refs',
      ]),
      step('events', C.events, ['events']),
      step('logs-mark', C.logs, ['logs', 'mark', 'agent-device perf']),
      step('perf-memory', C.perf, ['perf', 'memory', 'sample']),
      step('react-native', C.reactNative, ['react-native', 'dismiss-overlay']),
      step('artifacts', C.artifacts, ['artifacts']),
    ],
  },
  {
    id: 'catalog',
    title: 'Catalog list: press forms, text entry, and scrolling',
    setup: toTab('Catalog', 'id="catalog-title"'),
    steps: [
      step('press-selector', C.press, ['press', 'id="category-produce"']),
      step('press-selector-settle', C.press, ['press', 'id="category-bakery"', '--settle']),
      step('press-ref', C.press, ['press', '{ref:category-pantry}']),
      step('press-ref-settle', C.press, ['press', '{ref:category-produce}', '--settle']),
      step('press-point', C.press, ['press', '{point:category-bakery}']),
      step('press-point-settle', C.press, ['press', '{point:category-pantry}', '--settle']),
      step('click-selector', C.click, ['click', 'id="category-all"']),
      step('click-ref', C.click, ['click', '{ref:category-bakery}']),
      step('click-point', C.click, ['click', '{point:category-pantry}']),
      step('click-settle', C.click, ['click', 'id="category-all"', '--settle']),
      step('press-count', C.press, [
        'press',
        '{point:category-produce}',
        '--count',
        '2',
        '--interval-ms',
        '50',
      ]),
      step('fill', C.fill, ['fill', 'id="catalog-search"', 'tart']),
      step('fill-settle', C.fill, ['fill', 'id="catalog-search"', 'kit', '--settle']),
      step('focus', C.focus, ['focus', '{point:catalog-search}']),
      step('type', C.type, ['type', ' box']),
      step('keyboard-return', C.keyboard, ['keyboard', 'return']),
      step('fill-clear', C.fill, ['fill', 'id="catalog-search"', ''], {
        after: [['keyboard', 'return']],
      }),
      step('scroll-down', C.scroll, ['scroll', 'down']),
      step('scroll-down-settle', C.scroll, ['scroll', 'down', '--settle']),
      step('scroll-top', C.scroll, ['scroll', 'top']),
      step('scroll-until', C.scroll, ['scroll', 'down', '--until', 'id="catalog-footer"']),
      step('swipe', C.swipe, ['swipe', '200', '300', '200', '650']),
      step('swipe-count', C.swipe, [
        'swipe',
        '200',
        '650',
        '200',
        '450',
        '--count',
        '2',
        '--pause-ms',
        '50',
        '--pattern',
        'ping-pong',
      ]),
    ],
  },
  {
    id: 'form',
    title: 'Form fields, keyboard, and submit',
    setup: toTab('Form', 'id="form-title"'),
    steps: [
      step('fill-name', C.fill, ['fill', 'id="field-name"', 'Ada Lovelace']),
      step('fill-email', C.fill, ['fill', 'id="field-email"', 'ada@example']),
      step('type-suffix', C.type, ['type', '.test']),
      step('keyboard-dismiss', C.keyboard, ['keyboard', 'dismiss'], {
        before: [['wait', 'label="Done" visible=true', '10000']],
      }),
      step('press-checkbox', C.press, ['press', 'id="checkbox-agree"'], {
        before: [['scroll', 'down', '--until', 'id="checkbox-agree"']],
      }),
      step('press-submit-settle', C.press, ['press', 'id="submit-order"', '--settle'], {
        before: [['scroll', 'down', '--until', 'id="submit-order"']],
      }),
    ],
  },
  {
    id: 'automation',
    title: 'Long press, native alerts, recording, tracing, and back navigation',
    setup: toSettingsLab('open-automation-lab', 'id="automation-title"'),
    steps: [
      step('record-start', C.record, ['record', 'start', '{out:automation.mp4}', '--hide-touches']),
      step('record-stop', C.record, ['record', 'stop'], {
        before: [
          ['scroll', 'down', '--until', 'id="automation-press"'],
          ['press', 'id="automation-press"'],
          ['wait', '1200'],
        ],
      }),
      step('trace-start', C.trace, ['trace', 'start', '{out:automation.trace}']),
      step('trace-stop', C.trace, ['trace', 'stop', '{out:automation.trace}'], {
        before: [['press', 'id="automation-press"']],
      }),
      step('longpress', C.longPress, ['longpress', 'id="automation-longpress"', '800'], {
        before: [['scroll', 'down', '--until', 'id="automation-longpress"']],
      }),
      step('longpress-settle', C.longPress, [
        'longpress',
        'id="automation-longpress"',
        '800',
        '--settle',
      ]),
      step('alert-open', C.press, ['press', 'id="automation-open-alert"'], {
        before: [['scroll', 'down', '--until', 'id="automation-open-alert"']],
      }),
      step('alert-wait', C.alert, ['alert', 'wait', '10000']),
      step('alert-get', C.alert, ['alert', 'get']),
      step('alert-accept', C.alert, ['alert', 'accept']),
      step('alert-dismiss', C.alert, ['alert', 'dismiss'], {
        before: [
          ['press', 'id="automation-open-alert"'],
          ['alert', 'wait', '10000'],
        ],
      }),
      step('logs-start', C.logs, ['logs', 'start']),
      step('logs-stop', C.logs, ['logs', 'stop']),
      step('network-dump', C.network, ['network', 'dump', '10']),
      step('back', C.back, ['back']),
      step('back-settle', C.back, ['back', '--settle'], {
        before: [
          ['click', 'id="open-automation-lab"'],
          ['wait', 'id="automation-title"', LANDMARK_WAIT_MS],
        ],
      }),
    ],
  },
  {
    id: 'heavy-feed',
    title: 'Heavy feed: Bluesky-depth tree (≥65 native levels) and virtualized list',
    setup: toSettingsLab('open-heavy-feed', 'id="heavy-feed-title"'),
    steps: [
      step('snapshot-i', C.snapshot, ['snapshot', '-i']),
      step('snapshot', C.snapshot, ['snapshot']),
      step('snapshot-raw', C.snapshot, ['snapshot', '--raw'], { expect: { maxDepthAtLeast: 64 } }),
      step('press-like-selector', C.press, ['press', 'id="heavy-post-0-like"']),
      step('press-like-settle', C.press, ['press', 'id="heavy-post-1-like"', '--settle']),
      step('press-like-ref', C.press, ['press', '{ref:heavy-post-0-like}']),
      step('press-like-point', C.press, ['press', '{point:heavy-post-0-like}']),
      step('wait-text', C.wait, ['wait', 'text', 'Liked posts: 2']),
      step('is-visible', C.is, ['is', 'visible', 'id="heavy-post-1-like"']),
      step('get-text', C.get, ['get', 'text', 'id="heavy-feed-last-action"']),
      step('find-text', C.find, ['find', 'text', 'Post 1:', 'exists']),
      step('longpress-post', C.longPress, ['longpress', 'id="heavy-post-1"', '800']),
      step('scroll-down', C.scroll, ['scroll', 'down']),
      step('snapshot-i-scrolled', C.snapshot, ['snapshot', '-i']),
      step('scroll-down-settle', C.scroll, ['scroll', 'down', '--settle']),
      step('swipe', C.swipe, ['swipe', '200', '650', '200', '300']),
      step('back', C.back, ['back']),
    ],
  },
  {
    id: 'session',
    title: 'Session teardown',
    setup: [],
    steps: [step('close', C.close, ['close'])],
  },
];

/**
 * Catalog commands the iOS suite does not time, with the reason. Every public command is either
 * measured by a step above or listed here; `ios-suite.test.ts` holds that partition.
 */
export const IOS_SUITE_EXCLUSIONS: Partial<Record<PublicCommand, string>> = {
  [C.boot]:
    'Simulator power cycle: CoreSimulator boot time dominates and it ends the session under test.',
  [C.shutdown]: 'Simulator power cycle: it ends the session and the runner under test.',
  [C.install]:
    'Bundle provisioning: simctl copy time dominates; the job installs the fixture once.',
  [C.reinstall]:
    'Bundle provisioning: simctl copy time dominates and it resets the app under test.',
  [C.uninstall]: 'Bundle provisioning: it removes the app under test.',
  [C.installFromSource]:
    'Bundle provisioning from a source build; the job installs a cached Release fixture.',
  [C.replay]: 'Composite runner: a replay is the sum of the measured commands it runs.',
  [C.test]: 'Composite runner: a test suite is the sum of the measured commands it runs.',
  [C.push]:
    'The fixture holds no notification authorization, so simctl refuses the payload; iOS push coverage is contract-only.',
  [C.audio]: 'Host audio capture needs a macOS audio permission that hosted runners do not grant.',
  [C.hover]: 'The iOS runtime refuses hover; it is a web pointer contract.',
  [C.viewport]: 'The iOS runtime refuses viewport; it resizes web viewports only.',
  [C.tvRemote]: 'tvOS only.',
  [C.fold]: 'iPhone Duo only; the suite device has one panel.',
  [C.telephony]: 'The iOS simulator runtime refuses simulated calls and SMS.',
  [C.hardwareButton]: 'The iOS simulator runtime refuses hardware-button presses.',
};

/** Partitions the measured and excluded catalog commands for the report. */
export function describeCoverage(
  scenarios: readonly SuiteScenario[],
  exclusions: Partial<Record<PublicCommand, string>>,
): { measured: string[]; excluded: { command: string; reason: string }[] } {
  const measured = [...new Set(scenarios.flatMap((s) => s.steps.map((step) => step.command)))];
  return {
    measured: measured.sort(),
    excluded: Object.entries(exclusions)
      .map(([command, reason]) => ({ command, reason: reason! }))
      .sort((a, b) => a.command.localeCompare(b.command)),
  };
}
