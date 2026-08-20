import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';

type PublicCommand = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];

type RepositoryEvidence = {
  path: string;
  test: string;
};

type TvOsCommandContractEntry =
  | {
      assertion: string;
      level: 'command-contract';
      owner: RepositoryEvidence;
    }
  | {
      assertion: string;
      level: 'command-contract';
      owner: RepositoryEvidence;
      admission: 'host-dependent';
    };

export type TvOsPlatformCoverageEntry =
  | {
      assertion: string;
      level: 'live';
      owner: RepositoryEvidence;
    }
  | TvOsCommandContractEntry
  | {
      assertion: string;
      level: 'capability-denial';
    }
  | {
      assertion: string;
      level: 'known-gap';
      trackingIssue: number;
    };

export type TvOsPlatformCoverageClassificationSummary = {
  capabilityDenial: number;
  contract: number;
  gap: number;
  live: number;
  total: number;
};

export const TVOS_COVERAGE_GAP_ISSUE = 1914;
export const TVOS_REMOTE_TEST_NAME =
  'Provider-backed integration tvOS remote flow maps navigation commands to runner remote presses';
export const TVOS_REMOTE_EVIDENCE: RepositoryEvidence = {
  path: 'test/integration/provider-scenarios/tvos-remote.test.ts',
  test: TVOS_REMOTE_TEST_NAME,
};
const TVOS_AUDIO_EVIDENCE: RepositoryEvidence = {
  path: 'src/core/__tests__/capability-plugin-routing-parity.test.ts',
  test: '(b.1) isCommandSupportedOnDevice is unchanged across the command x device matrix',
};
export const TVOS_REMOTE_SCENARIO_COMMANDS: readonly PublicCommand[] = [
  PUBLIC_COMMANDS.open,
  PUBLIC_COMMANDS.scroll,
  PUBLIC_COMMANDS.back,
  PUBLIC_COMMANDS.home,
  PUBLIC_COMMANDS.close,
];

const C = PUBLIC_COMMANDS;
const contract = (
  path: string,
  test: string,
  assertion: string,
  admission?: 'host-dependent',
): TvOsPlatformCoverageEntry => ({
  assertion,
  level: 'command-contract',
  owner: { path, test },
  ...(admission ? { admission } : {}),
});
const denial = (assertion: string): TvOsPlatformCoverageEntry => ({
  assertion,
  level: 'capability-denial',
});
const gap = (assertion: string): TvOsPlatformCoverageEntry => ({
  assertion,
  level: 'known-gap',
  trackingIssue: TVOS_COVERAGE_GAP_ISSUE,
});

/**
 * One primary, observable owner for every public command on the tvOS leaf.
 *
 * There is no tvOS CI or live-device lane at HEAD, so the existing provider
 * scenario is contract evidence rather than a live claim. The remaining
 * contract rows cite Apple deployment/inventory tests, the typed Apple
 * interaction policy, or the executable capability oracle. Capability denials
 * are limited to whole-command denials; tvOS's narrower multi-touch refusal
 * stays with the gesture contract instead of denying the supported one-contact
 * gesture path. Host-dependent contracts retain their oracle admission state
 * without claiming a stable tvOS capability.
 */
export const TVOS_PLATFORM_COVERAGE = {
  [C.artifacts]: gap('No tvOS-specific artifact inventory command evidence exists yet'),
  [C.devices]: contract(
    'packages/platform-apple/src/simulator-inventory.test.ts',
    'simctl parser keeps available supported runtimes and their target semantics',
    'tvOS simulator inventory preserves the tv target and tvOS Apple-OS identity',
  ),
  [C.capabilities]: gap('No tvOS-specific capabilities command evidence exists yet'),
  [C.doctor]: gap('No tvOS-specific doctor command evidence exists yet'),
  [C.apps]: gap('No tvOS-specific app inventory command evidence exists yet'),
  [C.boot]: gap('No tvOS-specific boot command evidence exists yet'),
  [C.shutdown]: gap('No tvOS-specific shutdown command evidence exists yet'),
  [C.appState]: gap('No tvOS-specific app-state command evidence exists yet'),
  [C.perf]: gap('No tvOS-specific performance command evidence exists yet'),
  [C.logs]: gap('No tvOS-specific app-log command evidence exists yet'),
  [C.events]: gap('No tvOS-specific session-event command evidence exists yet'),
  [C.network]: gap('No tvOS-specific network command evidence exists yet'),
  [C.audio]: contract(
    TVOS_AUDIO_EVIDENCE.path,
    TVOS_AUDIO_EVIDENCE.test,
    'tvOS audio admission follows the host-dependent ScreenCaptureKit capability oracle',
    'host-dependent',
  ),
  [C.replay]: gap('No tvOS-specific replay command evidence exists yet'),
  [C.test]: gap('No tvOS-specific test-suite command evidence exists yet'),
  [C.clipboard]: gap('No tvOS-specific clipboard command evidence exists yet'),
  [C.keyboard]: denial('tvOS capability admission rejects keyboard input on the focus-only leaf'),
  [C.install]: contract(
    'packages/platform-apple/src/deployment/runtime.test.ts',
    'classifies deployment facts for the %s denominator cell',
    'shared Apple deployment facts admit app installation on tvOS simulators',
  ),
  [C.reinstall]: contract(
    'packages/platform-apple/src/deployment/runtime.test.ts',
    'classifies deployment facts for the %s denominator cell',
    'shared Apple deployment facts admit the operation used by tvOS install and reinstall',
  ),
  [C.push]: contract(
    'packages/platform-apple/src/deployment/runtime.test.ts',
    'classifies deployment facts for the %s denominator cell',
    'shared Apple deployment facts admit simulator push notifications for tvOS',
  ),
  [C.triggerAppEvent]: gap('No tvOS-specific app-event command evidence exists yet'),
  [C.open]: contract(
    TVOS_REMOTE_EVIDENCE.path,
    TVOS_REMOTE_EVIDENCE.test,
    'the existing provider scenario launches a tvOS app through the Apple tool provider',
  ),
  [C.prepare]: gap('No tvOS-specific runner preparation command evidence exists yet'),
  [C.batch]: gap('No tvOS-specific batch command evidence exists yet'),
  [C.close]: contract(
    TVOS_REMOTE_EVIDENCE.path,
    TVOS_REMOTE_EVIDENCE.test,
    'the existing provider scenario terminates the tvOS app and releases the session',
  ),
  [C.snapshot]: gap('No tvOS-specific snapshot command evidence exists yet'),
  [C.diff]: gap('No tvOS-specific snapshot-diff command evidence exists yet'),
  [C.wait]: gap('No tvOS-specific wait command evidence exists yet'),
  [C.alert]: gap('No tvOS-specific alert command evidence exists yet'),
  [C.settings]: gap('No tvOS-specific settings command evidence exists yet'),
  [C.reactNative]: gap('No tvOS-specific React Native inspection command evidence exists yet'),
  [C.record]: gap('No tvOS-specific recording command evidence exists yet'),
  [C.trace]: gap('No tvOS-specific trace command evidence exists yet'),
  [C.find]: gap('No tvOS-specific find command evidence exists yet'),
  [C.click]: gap('No tvOS-specific click command evidence exists yet'),
  [C.fill]: gap('No tvOS-specific fill command evidence exists yet'),
  [C.longPress]: gap('No tvOS-specific long-press command evidence exists yet'),
  [C.hover]: denial('tvOS capability admission rejects pointer-only hover input'),
  [C.press]: gap('No tvOS-specific press command evidence exists yet'),
  [C.type]: gap('No tvOS-specific type command evidence exists yet'),
  [C.get]: gap('No tvOS-specific get command evidence exists yet'),
  [C.is]: gap('No tvOS-specific predicate command evidence exists yet'),
  [C.back]: contract(
    TVOS_REMOTE_EVIDENCE.path,
    TVOS_REMOTE_EVIDENCE.test,
    'the existing provider scenario maps Back to the tvOS Menu remote press',
  ),
  [C.gesture]: contract(
    'src/core/__tests__/gesture-capabilities.test.ts',
    'TV, spatial, watch, desktop, Linux, and web gesture policy stays explicit',
    'the typed Apple gesture policy refuses tvOS multi-touch while preserving the narrower gesture contract',
  ),
  [C.home]: contract(
    TVOS_REMOTE_EVIDENCE.path,
    TVOS_REMOTE_EVIDENCE.test,
    'the existing provider scenario maps Home to the tvOS Home remote press',
  ),
  [C.tvRemote]: contract(
    'src/core/__tests__/dispatch-tv-remote.test.ts',
    'dispatch tv-remote sends native tvOS remotePress command',
    'tvOS tv-remote dispatch emits the native remotePress runner command',
  ),
  [C.orientation]: denial('tvOS capability admission rejects device orientation changes'),
  [C.scroll]: contract(
    TVOS_REMOTE_EVIDENCE.path,
    TVOS_REMOTE_EVIDENCE.test,
    'the existing provider scenario maps tvOS scroll direction to a remote press',
  ),
  [C.swipe]: gap('No tvOS-specific swipe command evidence exists yet'),
  [C.focus]: gap('No tvOS-specific focus command evidence exists yet'),
  [C.screenshot]: gap('No tvOS-specific screenshot command evidence exists yet'),
  [C.viewport]: gap('No tvOS-specific viewport command evidence exists yet'),
  [C.appSwitcher]: gap('No tvOS-specific app-switcher command evidence exists yet'),
  [C.installFromSource]: contract(
    'packages/platform-apple/src/deployment/runtime.test.ts',
    'classifies deployment facts for the %s denominator cell',
    'shared Apple deployment operations expose source materialization for admitted tvOS deployment',
  ),
} satisfies Record<PublicCommand, TvOsPlatformCoverageEntry>;

export const TVOS_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(TVOS_PLATFORM_COVERAGE),
);

function buildCoverageClassificationSummary(
  entries: readonly TvOsPlatformCoverageEntry[],
): TvOsPlatformCoverageClassificationSummary {
  const summary: TvOsPlatformCoverageClassificationSummary = {
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
