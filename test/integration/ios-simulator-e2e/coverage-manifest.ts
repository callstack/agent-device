import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';

type PublicCommand = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];

type RepositoryEvidence = {
  path: string;
  test: string;
};

export type IosSimulatorCoverageEntry =
  | {
      assertion: string;
      level: 'live';
      owner: string;
    }
  | {
      assertion: string;
      level: 'command-contract' | 'workflow-live' | 'capability-denial';
      owner: RepositoryEvidence;
    };

const C = PUBLIC_COMMANDS;
const live = (owner: string, assertion: string): IosSimulatorCoverageEntry => ({
  assertion,
  level: 'live',
  owner,
});
const contract = (path: string, test: string, assertion: string): IosSimulatorCoverageEntry => ({
  assertion,
  level: 'command-contract',
  owner: { path, test },
});

/**
 * One primary owner for every public command on an iOS mobile simulator.
 *
 * "live" means a real simulator scenario does more than check exit status: it
 * asserts app/device state, typed data, or an artifact. Command-contract rows
 * are deliberately not presented as E2E coverage; they point to a named test
 * for functionality whose host permissions or source transport makes it a poor
 * fit for the shared hosted-simulator lane. This is catalog-complete command
 * ownership, not a claim that every optional backend or subcommand runs
 * nightly; cross-command mobile journeys are tracked separately in
 * behavior-coverage.ts.
 */
export const IOS_SIMULATOR_E2E_COVERAGE = {
  [C.alert]: live('smoke:automation-input', 'native alert get, dismiss, and accept update the app'),
  [C.appSwitcher]: live(
    'full:lifecycle-system',
    'app switcher covers fixture controls and differs from Home before restoration',
  ),
  [C.apps]: live('smoke:inventory-install', 'installed fixture bundle appears in app inventory'),
  [C.appState]: live(
    'full:lifecycle-system',
    'session-backed state names the fixture bundle and selected simulator',
  ),
  [C.artifacts]: contract(
    'src/daemon/__tests__/http-server-artifacts.test.ts',
    'daemon artifact inventory lists artifacts and downloads consume them',
    'daemon inventory exposes a typed non-empty artifact and its downloadable bytes',
  ),
  [C.audio]: contract(
    'src/daemon/handlers/__tests__/session-audio.test.ts',
    'audio probe starts host helper for iOS simulator audio',
    'host audio permission and probe lifecycle; ScreenCaptureKit is not available on hosted CI',
  ),
  [C.back]: live('smoke:automation-input', 'back navigation returns from the automation route'),
  [C.batch]: live('full:observability-artifacts', 'nested get/is results are asserted'),
  [C.boot]: live(
    'full:device-lifecycle',
    'shutdown simulator boots again and inventory confirms it',
  ),
  [C.capabilities]: live(
    'smoke:inventory-install',
    'typed capability response includes fixture-driving commands',
  ),
  [C.click]: live('smoke:automation-input', 'selector click opens the automation lab'),
  [C.clipboard]: live('full:lifecycle-system', 'Unicode clipboard value round-trips exactly'),
  [C.close]: live('smoke:capture-close', 'session inventory proves the app lease is removed'),
  [C.devices]: live('smoke:inventory-install', 'selected simulator UDID appears in inventory'),
  [C.diff]: live('smoke:form-input', 'snapshot diff observes a form state mutation'),
  [C.doctor]: live('smoke:inventory-install', 'doctor discovers the installed fixture app'),
  [C.events]: live('full:observability-artifacts', 'timeline contains commands from this session'),
  [C.fill]: live('smoke:form-input', 'replacement text is read back from the fixture input'),
  [C.find]: live('smoke:automation-input', 'find reports the automation heading'),
  [C.focus]: live(
    'smoke:form-input',
    'snapshot-derived field coordinates focus the target before typed text is read back',
  ),
  [C.gesture]: live(
    'full:fixture-replays',
    'fixture gesture counters prove pan/fling/pinch/rotate',
  ),
  [C.get]: live('smoke:automation-input', 'get returns automation canary text/attributes'),
  [C.home]: live(
    'full:lifecycle-system',
    'fixture AppState becomes non-active and system pixels replace foreground pixels',
  ),
  [C.install]: live('smoke:inventory-install', 'public CLI installs the cached fixture .app'),
  [C.installFromSource]: contract(
    'packages/platform-apple/src/deployment/runtime.test.ts',
    'exposes only fact-admitted Apple deployment operations',
    'fact-admitted local .app materialization, simulator install dispatch, and typed identity',
  ),
  [C.is]: live('smoke:automation-input', 'visible/editable predicates pass on fixture nodes'),
  [C.keyboard]: live(
    'smoke:form-input',
    'real keyboard dismissal reports dismissed=true and visible=false',
  ),
  [C.logs]: live(
    'full:observability-artifacts',
    'iOS simulator stream starts, exposes its concrete app.log path, and stops',
  ),
  [C.longPress]: live(
    'smoke:automation-input',
    'an 800ms hold increments the durable long-press counter',
  ),
  [C.network]: contract(
    'packages/platform-apple/src/network/runtime.test.ts',
    'recovers an empty iOS simulator dump from bounded simctl log history',
    'iOS simulator recovery parses HTTP status, duration, and URL from bounded logs',
  ),
  [C.open]: live('smoke:automation-input', 'fixture cold launch and deep route become visible'),
  [C.orientation]: live(
    'full:lifecycle-system',
    'native runner reads back exact landscape-left and portrait device states',
  ),
  [C.perf]: live(
    'full:observability-artifacts',
    'startup duration, resident memory, and CPU usage are typed and numeric',
  ),
  [C.prepare]: {
    assertion: 'cached XCTest runner is prepared once before Settings and fixture suites',
    level: 'workflow-live',
    owner: {
      path: '.github/workflows/ios.yml',
      test: 'Preflight iOS runner through public CLI',
    },
  },
  [C.press]: live('smoke:automation-input', 'semantic press updates a durable input canary'),
  [C.push]: contract(
    'src/platforms/apple/core/__tests__/apps.test.ts',
    'pushIosNotification uses simctl push with temporary payload file',
    'simctl push dispatch; fixture has no notification entitlement or UI oracle',
  ),
  [C.reactNative]: live(
    'full:observability-artifacts',
    'Release fixture returns typed detected=false and dismissed=false overlay state',
  ),
  [C.record]: live('full:observability-artifacts', 'visible mutation produces a playable MP4'),
  [C.reinstall]: live(
    'full:device-lifecycle',
    'cached fixture is reinstalled with typed bundle identity and app path',
  ),
  [C.replay]: live('full:fixture-replays', 'a fixture .ad flow runs through public replay'),
  [C.screenshot]: live('smoke:capture-close', 'captured file has a valid PNG signature'),
  [C.scroll]: live(
    'full:lifecycle-system',
    'bottom-edge traversal executes a live scroll pass and reports the reached edge',
  ),
  [C.settings]: live(
    'full:lifecycle-system',
    'appearance changes are visible in useColorScheme and restored',
  ),
  [C.shutdown]: live(
    'full:device-lifecycle',
    'shutdown succeeds and inventory reports the selected simulator stopped',
  ),
  [C.snapshot]: live(
    'smoke:automation-input',
    'scoped interactive tree includes the stable fixture title',
  ),
  [C.swipe]: live(
    'full:fixture-replays',
    'fixture direction canary proves both compact-safe directional swipes move content',
  ),
  [C.test]: live('full:fixture-replays', 'fixture scripts run as a suite with JUnit artifacts'),
  [C.trace]: live(
    'full:observability-artifacts',
    'typed start/stop lifecycle retains the requested path and captures non-empty diagnostics',
  ),
  [C.triggerAppEvent]: live(
    'full:lifecycle-system',
    'custom-scheme event name and JSON payload render in the fixture',
  ),
  [C.tvRemote]: {
    assertion: 'iOS mobile simulator capability model rejects TV remote input',
    level: 'capability-denial',
    owner: {
      path: 'test/integration/smoke-ios-simulator-coverage.test.ts',
      test: 'capability classifications match executable simulator behavior',
    },
  },
  [C.type]: live(
    'smoke:form-input',
    'AX-independent first-responder typing appends and is read back from a focused fixture field',
  ),
  [C.hover]: {
    assertion: 'iOS simulator capability model rejects hover, a pointer-only web contract',
    level: 'capability-denial',
    owner: {
      path: 'test/integration/smoke-ios-simulator-coverage.test.ts',
      test: 'capability classifications match executable simulator behavior',
    },
  },
  [C.viewport]: {
    assertion: 'iOS simulator capability model rejects viewport resizing, a web-only contract',
    level: 'capability-denial',
    owner: {
      path: 'test/integration/smoke-ios-simulator-coverage.test.ts',
      test: 'capability classifications match executable simulator behavior',
    },
  },
  [C.wait]: live('smoke:automation-input', 'polling observes durable fixture state'),
} satisfies Record<PublicCommand, IosSimulatorCoverageEntry>;

export function liveCommandsForScenario(scenarioId: string): PublicCommand[] {
  return Object.entries(IOS_SIMULATOR_E2E_COVERAGE)
    .filter(([, entry]) => entry.level === 'live' && entry.owner === scenarioId)
    .map(([command]) => command as PublicCommand);
}
