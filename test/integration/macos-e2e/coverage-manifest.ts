import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import {
  MACOS_LIVE_SCENARIOS,
  type MacOsLiveScenario,
  type MacOsLiveScenarioId,
} from './live-scenarios.ts';

export { MACOS_LIVE_SCENARIOS } from './live-scenarios.ts';

type PublicCommand = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];

type RepositoryEvidence = {
  path: string;
  test: string;
};

export type MacOsPlatformCoverageEntry =
  | {
      assertion: string;
      level: 'live';
      owner: RepositoryEvidence;
      scenario: MacOsLiveScenarioId;
    }
  | {
      assertion: string;
      level: 'command-contract' | 'capability-denial';
      owner: RepositoryEvidence;
    }
  | {
      assertion: string;
      level: 'known-gap';
      trackingIssue: number;
    };

export type MacOsPlatformCoverageClassificationSummary = {
  capabilityDenial: number;
  contract: number;
  gap: number;
  live: number;
  total: number;
};

export const MACOS_COVERAGE_GAP_ISSUE = 1916;

const C = PUBLIC_COMMANDS;
const live = (scenario: MacOsLiveScenarioId, assertion: string): MacOsPlatformCoverageEntry => ({
  assertion,
  level: 'live',
  owner: liveScenario(scenario).owner,
  scenario,
});
const contract = (path: string, test: string, assertion: string): MacOsPlatformCoverageEntry => ({
  assertion,
  level: 'command-contract',
  owner: { path, test },
});
const denial = (path: string, test: string, assertion: string): MacOsPlatformCoverageEntry => ({
  assertion,
  level: 'capability-denial',
  owner: { path, test },
});
const gap = (assertion: string): MacOsPlatformCoverageEntry => ({
  assertion,
  level: 'known-gap',
  trackingIssue: MACOS_COVERAGE_GAP_ISSUE,
});

/** One primary, observable owner for every public command on the local macOS host. */
export const MACOS_PLATFORM_COVERAGE = {
  [C.artifacts]: contract(
    'src/daemon/__tests__/http-server-artifacts.test.ts',
    'daemon artifact inventory lists artifacts and downloads consume them',
    'daemon artifact inventory exposes downloadable files for the macOS session tooling',
  ),
  [C.devices]: contract(
    'packages/platform-apple/src/inventory.test.ts',
    'Apple inventory projects the host Mac without loading native tools',
    'Apple inventory projects the local macOS host as a desktop device',
  ),
  [C.capabilities]: contract(
    'src/core/__tests__/capabilities.test.ts',
    'macOS supports the Apple runner interaction core but excludes mobile-only commands',
    'the capability matrix admits the verified macOS interaction core',
  ),
  [C.doctor]: gap('No command-specific macOS doctor evidence exists yet'),
  [C.apps]: live(
    'provider:macos-desktop',
    'provider-backed app inventory lists macOS applications',
  ),
  [C.boot]: contract(
    'src/daemon/handlers/__tests__/session-boot-shutdown.test.ts',
    'boot rejects the macOS host boot cell after one facts inspection and before binding',
    'macOS boot is refused by the runtime fact before dispatch',
  ),
  [C.shutdown]: gap('No command-specific macOS shutdown evidence exists yet'),
  [C.appState]: live('replay:system-settings', 'the System Settings replay reads macOS app state'),
  [C.perf]: contract(
    'src/daemon/handlers/__tests__/session-appstate-input-perf.test.ts',
    'perf memory samples macOS app sessions',
    'macOS app memory sampling returns typed performance data',
  ),
  [C.logs]: live('provider:macos-desktop', 'the provider scenario returns the macOS app log path'),
  [C.events]: gap('No command-specific macOS event timeline evidence exists yet'),
  [C.network]: contract(
    'packages/platform-apple/src/network/runtime.test.ts',
    'parses macOS session app-log traffic without loading simulator recovery',
    'macOS network capture parses HTTP traffic from the session app log',
  ),
  [C.audio]: contract(
    'src/daemon/handlers/__tests__/session-audio.test.ts',
    'audio probe starts macOS ScreenCaptureKit helper and reads status',
    'macOS audio probe starts the ScreenCaptureKit helper and reports its backend',
  ),
  [C.replay]: gap('No command-specific macOS replay evidence exists beyond the suite runner'),
  [C.test]: gap('No command-specific macOS test-suite evidence exists yet'),
  [C.clipboard]: live(
    'provider:macos-desktop',
    'the provider scenario round-trips desktop clipboard text',
  ),
  [C.keyboard]: denial(
    'src/platforms/apple/capabilities.ts',
    'readonly keyboard',
    'macOS capability declarations reject hardware keyboard operations',
  ),
  [C.install]: contract(
    'packages/platform-apple/src/deployment/runtime.test.ts',
    'classifies deployment facts for the %s denominator cell',
    'Apple deployment facts close application installation on the macOS host',
  ),
  [C.reinstall]: contract(
    'packages/platform-apple/src/deployment/runtime.test.ts',
    'classifies deployment facts for the %s denominator cell',
    'Apple deployment facts close application reinstallation on the macOS host',
  ),
  [C.push]: contract(
    'packages/platform-apple/src/deployment/runtime.test.ts',
    'classifies deployment facts for the %s denominator cell',
    'Apple deployment facts close push delivery on the macOS host',
  ),
  [C.triggerAppEvent]: contract(
    'src/core/__tests__/dispatch-trigger-app-event.test.ts',
    'trigger-app-event supports macOS and prefers macOS template',
    'macOS app-event dispatch selects the macOS URL template',
  ),
  [C.open]: live('replay:system-settings', 'the System Settings replay opens the macOS target app'),
  [C.prepare]: live(
    'provider:macos-desktop',
    'the provider scenario prepares the macOS XCTest runner through its lifecycle provider',
  ),
  [C.batch]: gap('No command-specific macOS batch evidence exists yet'),
  [C.close]: contract(
    'src/daemon/handlers/__tests__/session-relaunch-close.test.ts',
    'close on macOS session stops runner and dismisses automation alert before delete',
    'macOS close stops the runner, dismisses automation state, and deletes the session',
  ),
  [C.snapshot]: live(
    'replay:system-settings',
    'the System Settings replay captures interactive macOS accessibility snapshots',
  ),
  [C.diff]: gap('No command-specific macOS snapshot-diff evidence exists yet'),
  [C.wait]: live(
    'replay:system-settings',
    'the System Settings replay waits for named macOS UI state',
  ),
  [C.alert]: live(
    'provider:macos-desktop',
    'the provider scenario reads, accepts, and dismisses the macOS automation alert',
  ),
  [C.settings]: live(
    'provider:macos-desktop',
    'the provider scenario changes macOS appearance and permissions through the helper',
  ),
  [C.reactNative]: gap('No command-specific macOS React Native inspection evidence exists yet'),
  [C.record]: live(
    'provider:macos-recording',
    'the provider scenario records and finalizes a playable macOS MP4',
  ),
  [C.trace]: gap('No command-specific macOS trace evidence exists yet'),
  [C.find]: gap('No command-specific macOS find evidence exists yet'),
  [C.click]: live(
    'replay:system-settings',
    'the System Settings replay clicks a named macOS control',
  ),
  [C.fill]: gap('No command-specific macOS fill evidence exists yet'),
  [C.longPress]: gap('No command-specific macOS long-press evidence exists yet'),
  [C.hover]: denial(
    'src/core/command-descriptor/registry.ts',
    'capability: { apple: {}, android: {}, linux: LINUX_NONE }',
    'the command capability declaration has no Apple hover bucket on macOS',
  ),
  [C.press]: live(
    'provider:macos-desktop',
    'the provider scenario presses a snapshot ref through the macOS helper',
  ),
  [C.type]: gap('No command-specific macOS type evidence exists yet'),
  [C.get]: live(
    'provider:macos-desktop',
    'the provider scenario reads snapshot-ref text from the macOS helper',
  ),
  [C.is]: live(
    'replay:system-settings',
    'the System Settings replay asserts a named macOS control exists',
  ),
  [C.back]: live(
    'replay:system-settings',
    'the System Settings replay returns from the About pane',
  ),
  [C.gesture]: contract(
    'src/platforms/apple/core/__tests__/interactions.test.ts',
    'performGestureApple composes macOS one-contact plans with the drag executor',
    'macOS gesture dispatch preserves the one-contact drag plan',
  ),
  [C.home]: denial(
    'src/platforms/apple/capabilities.ts',
    'appAndDeviceLifecycle',
    'macOS capability declarations reject mobile Home navigation',
  ),
  [C.tvRemote]: denial(
    'src/platforms/apple/plugin.ts',
    'supportsTvRemote',
    'the Apple plugin admits TV remote input only for tvOS or Android TV',
  ),
  [C.orientation]: denial(
    'src/platforms/apple/capabilities.ts',
    'readonly orientation',
    'macOS capability declarations reject device orientation changes',
  ),
  [C.scroll]: live(
    'provider:macos-desktop',
    'the provider scenario maps desktop scrolling to the macOS wheel runner command',
  ),
  [C.swipe]: gap('No command-specific macOS swipe evidence exists yet'),
  [C.focus]: gap('No command-specific macOS focus evidence exists yet'),
  [C.screenshot]: live(
    'replay:system-settings',
    'the System Settings replay writes a macOS screenshot artifact',
  ),
  [C.viewport]: contract(
    'packages/platform-apple/src/runtime.test.ts',
    'classifies the %s leaf explicitly',
    'Apple runtime facts reject viewport resizing on the macOS host',
  ),
  [C.appSwitcher]: denial(
    'src/platforms/apple/capabilities.ts',
    'appAndDeviceLifecycle',
    'macOS capability declarations reject mobile app-switcher navigation',
  ),
  [C.installFromSource]: contract(
    'packages/platform-apple/src/deployment/runtime.test.ts',
    'classifies deployment facts for the %s denominator cell',
    'Apple deployment facts close source installation on the macOS host',
  ),
} satisfies Record<PublicCommand, MacOsPlatformCoverageEntry>;

export const MACOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(MACOS_PLATFORM_COVERAGE),
);

export function liveCommandsForScenario(scenarioId: string): PublicCommand[] {
  return Object.entries(MACOS_PLATFORM_COVERAGE)
    .filter(([, entry]) => entry.level === 'live' && entry.scenario === scenarioId)
    .map(([command]) => command as PublicCommand);
}

function liveScenario(scenarioId: MacOsLiveScenarioId): MacOsLiveScenario {
  const scenario = MACOS_LIVE_SCENARIOS.find((candidate) => candidate.id === scenarioId);
  if (!scenario) throw new Error(`Unknown macOS coverage scenario: ${scenarioId}`);
  return scenario;
}

function buildCoverageClassificationSummary(
  entries: readonly MacOsPlatformCoverageEntry[],
): MacOsPlatformCoverageClassificationSummary {
  const summary: MacOsPlatformCoverageClassificationSummary = {
    capabilityDenial: 0,
    contract: 0,
    gap: 0,
    live: 0,
    total: entries.length,
  };
  for (const entry of entries) {
    switch (entry.level) {
      case 'live':
        summary.live += 1;
        break;
      case 'command-contract':
        summary.contract += 1;
        break;
      case 'capability-denial':
        summary.capabilityDenial += 1;
        break;
      case 'known-gap':
        summary.gap += 1;
        break;
    }
  }
  return summary;
}
