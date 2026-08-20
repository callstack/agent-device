import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { ANDROID_AUDIO_CONTRACT_EVIDENCE } from '../../../src/daemon/handlers/__tests__/session-audio.coverage.ts';
import { ANDROID_INSTALL_SOURCE_CONTRACT_EVIDENCE } from '../../../src/platforms/__tests__/install-source.coverage.ts';
import { ANDROID_LIFECYCLE_CONTRACT_EVIDENCE } from '../provider-scenarios/android-lifecycle.coverage.ts';
import { buildCoverageClassificationSummary } from '../support/coverage-classification.ts';
import {
  defineAndroidContractEvidence,
  type AndroidContractEvidence,
} from './contract-evidence.ts';

type PublicCommand = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];

export type AndroidEmulatorCoverageEntry =
  | { assertion: string; level: 'live'; scenario: string }
  | {
      assertion: string;
      evidence: AndroidContractEvidence;
      level: 'command-contract';
    }
  | { assertion: string; level: 'capability-denial' };

const C = PUBLIC_COMMANDS;
const live = (scenario: string, assertion: string): AndroidEmulatorCoverageEntry => ({
  assertion,
  level: 'live',
  scenario,
});
const contract = (
  evidence: AndroidContractEvidence,
  assertion: string,
): AndroidEmulatorCoverageEntry => ({
  assertion,
  evidence,
  level: 'command-contract',
});
const ANDROID_APPLICATION_LIFECYCLE_CONTRACT_EVIDENCE = defineAndroidContractEvidence(
  'packages/platform-android/src/runtime.test.ts',
  [C.prepare],
  'Android platform runtime classifies prepareAppleRunner unavailable',
);
const ANDROID_VIEWPORT_RUNTIME_CONTRACT_EVIDENCE = defineAndroidContractEvidence(
  'src/daemon/__tests__/viewport-runtime.test.ts',
  [C.viewport],
  'rejects an unavailable exact-owner fact before binding',
);

/** One primary, observable owner for every public command on an Android emulator. */
export const ANDROID_EMULATOR_E2E_COVERAGE = {
  [C.alert]: live('smoke:automation-system', 'native alert actions update fixture-visible results'),
  [C.appSwitcher]: live(
    'smoke:automation-system',
    'Recents pixels differ from Home and the fixture restores through Android app state',
  ),
  [C.apps]: live('smoke:inventory', 'installed fixture package appears in app inventory'),
  [C.appState]: live(
    'smoke:automation-system',
    'Android foreground package changes on Home and returns to the fixture after restoration',
  ),
  [C.artifacts]: live(
    'full:observability-artifacts',
    'inventory exposes generated recording and trace artifacts and one download consumes its entry',
  ),
  [C.audio]: contract(
    ANDROID_AUDIO_CONTRACT_EVIDENCE,
    'host audio probing has an Android-emulator session contract',
  ),
  [C.back]: live('smoke:automation-system', 'back returns from automation to the Settings tab'),
  [C.batch]: live(
    'full:observability-artifacts',
    'nested get and is results retain their Android fixture evidence',
  ),
  [C.boot]: contract(
    ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
    'provider scenario asserts typed Android boot result',
  ),
  [C.capabilities]: live(
    'smoke:inventory',
    'typed capability response includes fixture-driving Android commands',
  ),
  [C.click]: live('smoke:automation-system', 'resource-id selector opens fixture controls'),
  [C.clipboard]: contract(
    ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
    'provider scenario round-trips Android clipboard text',
  ),
  [C.close]: live('smoke:capture-close', 'session inventory proves fixture lease removal'),
  [C.devices]: live('smoke:inventory', 'selected emulator serial appears in inventory'),
  [C.diff]: live(
    'smoke:automation-system',
    'snapshot diff observes the Automation-to-Settings transition',
  ),
  [C.doctor]: live('smoke:inventory', 'doctor discovers the installed fixture package'),
  [C.events]: live(
    'full:observability-artifacts',
    'paged timeline includes commands from the active Android fixture session',
  ),
  [C.fill]: live('smoke:form-input', 'replacement form text is read back from Android UI'),
  [C.find]: live('smoke:automation-system', 'find observes the automation landmark'),
  [C.focus]: live('smoke:form-input', 'snapshot-derived Android field point receives typed text'),
  [C.gesture]: live(
    'full:fixture-replays',
    'helper-backed one- and two-pointer gestures produce every fixture transform effect',
  ),
  [C.get]: live('smoke:automation-system', 'get returns fixture automation canary text'),
  [C.home]: live(
    'smoke:automation-system',
    'Home changes Android foreground evidence before the fixture is restored',
  ),
  [C.install]: live('smoke:fixture-bootstrap', 'public CLI installs cached/repacked fixture APK'),
  [C.installFromSource]: contract(
    ANDROID_INSTALL_SOURCE_CONTRACT_EVIDENCE,
    'Android install-source resolves an installable artifact with typed identity',
  ),
  [C.is]: live('smoke:automation-system', 'visible predicate passes for Android fixture node'),
  [C.keyboard]: live('smoke:keyboard-ime', 'safe dismissal hides keyboard without navigating Back'),
  [C.logs]: live(
    'full:observability-artifacts',
    'Android logcat starts, exposes a concrete path, and stops cleanly',
  ),
  [C.longPress]: live('smoke:automation-system', '800ms hold increments durable fixture counter'),
  [C.network]: contract(
    ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
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
  [C.perf]: live(
    'full:observability-artifacts',
    'startup, process memory, and CPU metrics are typed and numeric on the emulator',
  ),
  [C.prepare]: contract(
    ANDROID_APPLICATION_LIFECYCLE_CONTRACT_EVIDENCE,
    'Android prepare fails closed through its unavailable prepareAppleRunner fact',
  ),
  [C.press]: live('smoke:automation-system', 'semantic press updates durable fixture input state'),
  [C.push]: live(
    'full:lifecycle-system',
    'typed broadcast extras are persisted by the fixture receiver and rendered after refresh',
  ),
  [C.reactNative]: contract(
    ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
    'provider scenario returns Android overlay dismissal state',
  ),
  [C.record]: live(
    'full:observability-artifacts',
    'short visible fixture mutation produces a non-empty playable Android MP4',
  ),
  [C.reinstall]: contract(
    ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
    'provider scenario validates APK and bundle reinstall identities',
  ),
  [C.replay]: live(
    'full:fixture-replays',
    'the catalog traversal fixture runs through replay without retrying its deterministic flow',
  ),
  [C.screenshot]: live('smoke:capture-close', 'captured fixture file has a valid PNG signature'),
  [C.scroll]: live(
    'full:fixture-replays',
    'edge-aware catalog traversal reaches its footer and safely rediscovers the top',
  ),
  [C.settings]: live(
    'full:lifecycle-system',
    'Android grant and deny permission transitions are observed by the fixture',
  ),
  [C.shutdown]: contract(
    ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
    'provider scenario asserts typed Android shutdown result',
  ),
  [C.snapshot]: live(
    'smoke:automation-system',
    'interactive tree exposes Android resource-id fixture nodes',
  ),
  [C.swipe]: live(
    'full:fixture-replays',
    'direct fixture swipe moves the catalog before edge-aware recovery',
  ),
  [C.test]: live('full:fixture-replays', 'deterministic fixture suite emits JUnit without retries'),
  [C.trace]: live(
    'full:observability-artifacts',
    'a visible fixture mutation creates non-empty trace diagnostics at the requested path',
  ),
  [C.triggerAppEvent]: contract(
    ANDROID_LIFECYCLE_CONTRACT_EVIDENCE,
    'provider scenario validates Android deep-link event delivery',
  ),
  [C.tvRemote]: {
    assertion: 'Android mobile emulator capability model rejects TV remote input',
    level: 'capability-denial',
  },
  [C.type]: live('smoke:form-input', 'typed suffix is read back from focused Android field'),
  [C.hover]: {
    assertion: 'Android emulator capability model rejects hover, a pointer-only web contract',
    level: 'capability-denial',
  },
  [C.viewport]: contract(
    ANDROID_VIEWPORT_RUNTIME_CONTRACT_EVIDENCE,
    'Android viewport fails closed through its unavailable exact-owner runtime fact',
  ),
  [C.wait]: live('smoke:automation-system', 'wait observes durable fixture landmarks'),
} satisfies Record<PublicCommand, AndroidEmulatorCoverageEntry>;

export const ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(ANDROID_EMULATOR_E2E_COVERAGE),
);

export function liveCommandsForScenario(scenarioId: string): PublicCommand[] {
  return Object.entries(ANDROID_EMULATOR_E2E_COVERAGE)
    .filter(([, entry]) => entry.level === 'live' && entry.scenario === scenarioId)
    .map(([command]) => command as PublicCommand);
}
