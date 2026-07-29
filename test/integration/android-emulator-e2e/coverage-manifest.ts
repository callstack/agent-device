import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';

type PublicCommand = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];

type RepositoryEvidence = {
  path: string;
};

export type AndroidEmulatorCoverageEntry =
  | { assertion: string; level: 'live'; scenario: string }
  | {
      assertion: string;
      evidence: RepositoryEvidence;
      level: 'command-contract' | 'workflow-live' | 'capability-denial';
    };

const C = PUBLIC_COMMANDS;
const live = (scenario: string, assertion: string): AndroidEmulatorCoverageEntry => ({
  assertion,
  level: 'live',
  scenario,
});
const contract = (path: string, assertion: string): AndroidEmulatorCoverageEntry => ({
  assertion,
  evidence: { path },
  level: 'command-contract',
});

const ANDROID_LIFECYCLE_CONTRACT = 'test/integration/provider-scenarios/android-lifecycle.test.ts';

/** One primary, observable owner for every public command on an Android emulator. */
export const ANDROID_EMULATOR_E2E_COVERAGE = {
  [C.alert]: live('smoke:automation-system', 'native alert actions update fixture-visible results'),
  [C.appSwitcher]: live(
    'smoke:automation-system',
    'Recents pixels differ from Home and the fixture restores through Android app state',
  ),
  [C.apps]: live('smoke:inventory-install', 'installed fixture package appears in app inventory'),
  [C.appState]: live(
    'smoke:automation-system',
    'Android foreground package changes on Home and returns to the fixture after restoration',
  ),
  [C.artifacts]: contract(
    'src/daemon/__tests__/http-server-artifacts.test.ts',
    'daemon inventory exposes typed downloadable artifact bytes',
  ),
  [C.audio]: contract(
    'src/daemon/handlers/__tests__/session-audio.test.ts',
    'host audio probing has an Android-emulator session contract',
  ),
  [C.back]: live('smoke:automation-system', 'back returns from automation to the Settings tab'),
  [C.batch]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario asserts typed nested Android batch outcomes',
  ),
  [C.boot]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario asserts typed Android boot result',
  ),
  [C.capabilities]: live(
    'smoke:inventory-install',
    'typed capability response includes fixture-driving Android commands',
  ),
  [C.click]: live('smoke:automation-system', 'resource-id selector opens fixture controls'),
  [C.clipboard]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario round-trips Android clipboard text',
  ),
  [C.close]: live('smoke:capture-close', 'session inventory proves fixture lease removal'),
  [C.devices]: live('smoke:inventory-install', 'selected emulator serial appears in inventory'),
  [C.diff]: live(
    'smoke:automation-system',
    'snapshot diff observes the Automation-to-Settings transition',
  ),
  [C.doctor]: live('smoke:inventory-install', 'doctor discovers the installed fixture package'),
  [C.events]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario records Android session command events',
  ),
  [C.fill]: live('smoke:form-input', 'replacement form text is read back from Android UI'),
  [C.find]: live('smoke:automation-system', 'find observes the automation landmark'),
  [C.focus]: live('smoke:form-input', 'snapshot-derived Android field point receives typed text'),
  [C.gesture]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario verifies Android single- and multi-touch plans',
  ),
  [C.get]: live('smoke:automation-system', 'get returns fixture automation canary text'),
  [C.home]: live(
    'smoke:automation-system',
    'Home changes Android foreground evidence before the fixture is restored',
  ),
  [C.install]: live('smoke:inventory-install', 'public CLI installs cached/repacked fixture APK'),
  [C.installFromSource]: contract(
    'src/platforms/__tests__/install-source.test.ts',
    'Android install-source resolves an installable artifact with typed identity',
  ),
  [C.is]: live('smoke:automation-system', 'visible predicate passes for Android fixture node'),
  [C.keyboard]: live('smoke:keyboard-ime', 'safe dismissal hides keyboard without navigating Back'),
  [C.logs]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario starts, inspects, restarts, and stops Android logcat',
  ),
  [C.longPress]: live('smoke:automation-system', '800ms hold increments durable fixture counter'),
  [C.network]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario returns typed Android network entries',
  ),
  [C.open]: live(
    'smoke:automation-system',
    'cold deep link and normal fixture launch render landmarks',
  ),
  [C.orientation]: live(
    'smoke:automation-system',
    'fixture window state observes landscape then portrait Android rotation',
  ),
  [C.perf]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario validates typed Android process metrics',
  ),
  [C.prepare]: {
    assertion: 'Android emulator capability model rejects Apple runner preparation',
    evidence: {
      path: 'test/integration/smoke-android-emulator-coverage.test.ts',
    },
    level: 'capability-denial',
  },
  [C.press]: live('smoke:automation-system', 'semantic press updates durable fixture input state'),
  [C.push]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario validates Android intent action and extras delivery',
  ),
  [C.reactNative]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario returns Android overlay dismissal state',
  ),
  [C.record]: contract(
    'test/integration/provider-scenarios/android-recording.test.ts',
    'Android recording finalizes through its durable manifest and pull contract',
  ),
  [C.reinstall]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario validates APK and bundle reinstall identities',
  ),
  [C.replay]: {
    assertion: 'narrow Android Settings replay remains an additive live workflow check',
    evidence: { path: '.github/workflows/android.yml' },
    level: 'workflow-live',
  },
  [C.screenshot]: live('smoke:capture-close', 'captured fixture file has a valid PNG signature'),
  [C.scroll]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario validates Android scroll plans and resulting actions',
  ),
  [C.settings]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario validates Android device setting mutations',
  ),
  [C.shutdown]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario asserts typed Android shutdown result',
  ),
  [C.snapshot]: live(
    'smoke:automation-system',
    'interactive tree exposes Android resource-id fixture nodes',
  ),
  [C.swipe]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario validates Android swipe execution',
  ),
  [C.test]: contract(
    'test/integration/provider-scenarios/android-test-suite.test.ts',
    'Android replay suite reports attempt outcomes and JUnit evidence',
  ),
  [C.trace]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario verifies Android trace lifecycle output',
  ),
  [C.triggerAppEvent]: contract(
    ANDROID_LIFECYCLE_CONTRACT,
    'provider scenario validates Android deep-link event delivery',
  ),
  [C.tvRemote]: {
    assertion: 'Android mobile emulator capability model rejects TV remote input',
    evidence: {
      path: 'test/integration/smoke-android-emulator-coverage.test.ts',
    },
    level: 'capability-denial',
  },
  [C.type]: live('smoke:form-input', 'typed suffix is read back from focused Android field'),
  [C.viewport]: {
    assertion: 'Android emulator capability model rejects standalone viewport control',
    evidence: {
      path: 'test/integration/smoke-android-emulator-coverage.test.ts',
    },
    level: 'capability-denial',
  },
  [C.wait]: live('smoke:automation-system', 'wait observes durable fixture landmarks'),
} satisfies Record<PublicCommand, AndroidEmulatorCoverageEntry>;

export function liveCommandsForScenario(scenarioId: string): PublicCommand[] {
  return Object.entries(ANDROID_EMULATOR_E2E_COVERAGE)
    .filter(([, entry]) => entry.level === 'live' && entry.scenario === scenarioId)
    .map(([command]) => command as PublicCommand);
}
