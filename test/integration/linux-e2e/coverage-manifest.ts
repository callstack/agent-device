import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
import { buildCoverageClassificationSummary } from '../support/coverage-classification.ts';

type PublicCommand = (typeof PUBLIC_COMMANDS)[keyof typeof PUBLIC_COMMANDS];

type RepositoryEvidence = {
  path: string;
  test: string;
};

type CapabilityDeclarationEvidence = RepositoryEvidence & {
  declaration: string;
};

export type LinuxPlatformCoverageEntry =
  | {
      assertion: string;
      level: 'live' | 'command-contract';
      owner: RepositoryEvidence;
    }
  | {
      assertion: string;
      level: 'capability-denial';
      owner: CapabilityDeclarationEvidence;
    }
  | {
      assertion: string;
      level: 'known-gap';
      trackingIssue: number;
    };

export const LINUX_COVERAGE_GAP_ISSUE = 1915;

export const LINUX_REPLAY_EVIDENCE: RepositoryEvidence = {
  path: 'test/integration/replays/linux/01-desktop-smoke.ad',
  test: '# Smoke test for Linux desktop automation on CI.',
};

const LINUX_PROVIDER_EVIDENCE: RepositoryEvidence = {
  path: 'test/integration/provider-scenarios/linux-desktop.test.ts',
  test: 'Provider-backed integration Linux desktop flow uses semantic desktop and input providers',
};

const LINUX_RUNTIME_EVIDENCE: RepositoryEvidence = {
  path: 'packages/platform-linux/src/runtime.test.ts',
  test: 'classifies the Linux $name lifecycle denominator against the legacy dispatch cell',
};

const LINUX_CAPABILITY_DECLARATION_PATH = 'src/core/command-descriptor/registry.ts';
const LINUX_CAPABILITY_DECLARATION = 'linux: LINUX_NONE';

const C = PUBLIC_COMMANDS;
const live = (assertion: string): LinuxPlatformCoverageEntry => ({
  assertion,
  level: 'live',
  owner: LINUX_REPLAY_EVIDENCE,
});
const contract = (path: string, test: string, assertion: string): LinuxPlatformCoverageEntry => ({
  assertion,
  level: 'command-contract',
  owner: { path, test },
});
const denial = (command: string, assertion: string): LinuxPlatformCoverageEntry => ({
  assertion,
  level: 'capability-denial',
  owner: {
    path: LINUX_CAPABILITY_DECLARATION_PATH,
    test: `name: '${command}'`,
    declaration: LINUX_CAPABILITY_DECLARATION,
  },
});
const gap = (assertion: string): LinuxPlatformCoverageEntry => ({
  assertion,
  level: 'known-gap',
  trackingIssue: LINUX_COVERAGE_GAP_ISSUE,
});

/**
 * One primary, observable owner for every public command on the Linux desktop.
 *
 * Live rows are limited to the existing Linux replay. Contract rows cite the
 * existing provider scenario or dedicated Linux unit/runtime evidence; they do
 * not turn mocked provider calls into live desktop claims. Capability denials
 * are derived from the owning command-descriptor matrix. Known gaps are
 * explicit follow-up work, not an implicit claim that a generic command works.
 */
export const LINUX_PLATFORM_COVERAGE = {
  [C.artifacts]: gap('No Linux-specific artifact inventory command evidence exists yet'),
  [C.devices]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario inventories the selected desktop device through the daemon client',
  ),
  [C.capabilities]: gap('No Linux-specific capabilities command evidence exists yet'),
  [C.doctor]: gap('No Linux-specific doctor command evidence exists yet'),
  [C.apps]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'Linux runtime facts explicitly report native app inventory unavailable',
  ),
  [C.boot]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'Linux runtime facts explicitly report boot unavailable for the desktop owner',
  ),
  [C.shutdown]: gap('No Linux-specific shutdown command evidence exists yet'),
  [C.appState]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'Linux runtime facts explicitly report app state unavailable',
  ),
  [C.perf]: denial('perf', 'Linux capability declaration rejects native performance inspection'),
  [C.logs]: gap('No Linux-specific app-log command evidence exists yet'),
  [C.events]: gap('No Linux-specific session event command evidence exists yet'),
  [C.network]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'Linux runtime facts explicitly report network capture unavailable',
  ),
  [C.audio]: denial('audio', 'Linux capability declaration rejects native audio probing'),
  [C.replay]: gap('No Linux-specific replay command evidence exists yet'),
  [C.test]: gap('No Linux-specific test-suite command evidence exists yet'),
  [C.clipboard]: contract(
    'src/platforms/linux/__tests__/clipboard.test.ts',
    'writeLinuxClipboard uses xclip with stdin on X11',
    'Linux clipboard writes through the supported X11 host-tool seam',
  ),
  [C.keyboard]: denial('keyboard', 'Linux capability declaration rejects native keyboard control'),
  [C.install]: gap('No Linux-specific application installation command evidence exists yet'),
  [C.reinstall]: gap('No Linux-specific application reinstallation command evidence exists yet'),
  [C.push]: gap('No Linux-specific push delivery command evidence exists yet'),
  [C.triggerAppEvent]: denial(
    'trigger-app-event',
    'Linux capability declaration rejects native application event delivery',
  ),
  [C.open]: live('the existing Linux replay opens gnome-calculator'),
  [C.prepare]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'Linux runtime facts explicitly report Apple runner preparation unavailable',
  ),
  [C.batch]: gap('No Linux-specific batch command evidence exists yet'),
  [C.close]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario closes the calculator and observes the desktop close call',
  ),
  [C.snapshot]: live('the existing Linux replay captures the calculator accessibility tree'),
  [C.diff]: gap('No Linux-specific snapshot diff command evidence exists yet'),
  [C.wait]: live('the existing Linux replay waits for an observable calculator landmark'),
  [C.alert]: denial('alert', 'Linux capability declaration rejects native alert operations'),
  [C.settings]: denial(
    'settings',
    'Linux capability declaration rejects native device settings operations',
  ),
  [C.reactNative]: denial(
    'react-native',
    'Linux capability declaration rejects React Native inspection',
  ),
  [C.record]: gap('No Linux-specific recording command evidence exists yet'),
  [C.trace]: gap('No Linux-specific trace command evidence exists yet'),
  [C.find]: gap('No Linux-specific find command evidence exists yet'),
  [C.click]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario executes primary, secondary, middle, and double clicks',
  ),
  [C.fill]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario fills both a snapshot ref and coordinate target',
  ),
  [C.longPress]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario executes a coordinate long press',
  ),
  [C.hover]: denial('hover', 'Linux capability declaration rejects pointer-only hover input'),
  [C.press]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario presses a snapshot ref and coordinate target',
  ),
  // The desktop replay runs the migrated typeText path on real hardware and uploads pixel
  // evidence of the typed entry each run, but GTK4 gnome-calculator exposes no Text-interface
  // content to selectors, so no tree-level assertion can hold and the claim stays at the
  // contract tier until that platform defect is fixed.
  [C.type]: contract(
    'src/platforms/linux/__tests__/input-actions.test.ts',
    'typeLinux uses ydotool type',
    'Linux type dispatch uses the Wayland ydotool type primitive',
  ),
  [C.get]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario reads the pressed snapshot ref text',
  ),
  [C.is]: live('the existing Linux replay verifies a calculator landmark exists'),
  [C.back]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario dispatches Alt+Left through the semantic input provider',
  ),
  [C.gesture]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario executes a single-pointer pan through the semantic drag provider',
  ),
  [C.home]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario dispatches Super+D through the semantic input provider',
  ),
  [C.tvRemote]: denial('tv-remote', 'Linux capability declaration rejects TV remote input'),
  [C.orientation]: denial(
    'orientation',
    'Linux capability declaration rejects native orientation changes',
  ),
  [C.scroll]: contract(
    'src/platforms/linux/__tests__/input-actions.test.ts',
    'scrollLinux uses ydotool mousemove --wheel for vertical scroll',
    'Linux scroll dispatch uses the Wayland ydotool wheel primitive',
  ),
  [C.swipe]: gap('No Linux-specific public swipe command evidence exists yet'),
  // Promoted from command-contract to live by #1925: the desktop replay now runs a coordinate
  // focus on real Linux hardware, so the migrated `focusPoint` path has live changed-path
  // evidence rather than only the provider scenario at LINUX_PROVIDER_EVIDENCE.
  [C.focus]: live('the Linux desktop replay focuses a coordinate on real hardware'),
  [C.screenshot]: live('the existing Linux replay creates a screenshot artifact'),
  [C.viewport]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'Linux runtime facts explicitly report viewport changes unavailable',
  ),
  [C.appSwitcher]: denial(
    'app-switcher',
    'Linux capability declaration rejects native app-switcher navigation',
  ),
  [C.installFromSource]: gap('No Linux-specific source-install command evidence exists yet'),
} satisfies Record<PublicCommand, LinuxPlatformCoverageEntry>;

export const LINUX_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(LINUX_PLATFORM_COVERAGE),
);

export function liveCommandsForLinuxReplay(): PublicCommand[] {
  return Object.entries(LINUX_PLATFORM_COVERAGE)
    .filter(([, entry]) => entry.level === 'live')
    .map(([command]) => command as PublicCommand);
}
