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

export const LINUX_COMMAND_EVIDENCE: RepositoryEvidence = {
  path: 'test/integration/linux-e2e/live-runner.ts',
  test: 'runLinuxCommandEvidence',
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
const live = (
  assertion: string,
  owner: RepositoryEvidence = LINUX_REPLAY_EVIDENCE,
): LinuxPlatformCoverageEntry => ({
  assertion,
  level: 'live',
  owner,
});
const commandEvidenceLive = (assertion: string): LinuxPlatformCoverageEntry =>
  live(assertion, LINUX_COMMAND_EVIDENCE);
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
 * Live rows cite either the existing Linux replay or the separate command-evidence
 * lane. The existing replay scope stays unchanged. Contract rows cite the existing
 * provider scenario or dedicated Linux unit/runtime evidence; they do not turn
 * mocked provider calls into live desktop claims. Capability denials are derived
 * from the owning command-descriptor matrix. Known gaps are explicit follow-up
 * work, not an implicit claim that a generic command works.
 */
export const LINUX_PLATFORM_COVERAGE = {
  [C.artifacts]: gap(
    'No Linux live command creates a downloadable daemon artifact for inventory yet',
  ),
  [C.devices]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario inventories the selected desktop device through the daemon client',
  ),
  [C.capabilities]: commandEvidenceLive(
    'the command-evidence lane reads capabilities for the selected Linux desktop',
  ),
  [C.doctor]: commandEvidenceLive('the command-evidence lane reads Linux doctor diagnostics'),
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
  [C.events]: commandEvidenceLive(
    'the command-evidence lane reads the event timeline produced by its Linux session',
  ),
  [C.network]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'Linux runtime facts explicitly report network capture unavailable',
  ),
  [C.audio]: denial('audio', 'Linux capability declaration rejects native audio probing'),
  [C.replay]: commandEvidenceLive(
    'the command-evidence lane replays a dedicated Linux script with a live session',
  ),
  [C.test]: commandEvidenceLive(
    'the command-evidence lane runs a dedicated Linux script as a test suite',
  ),
  [C.clipboard]: contract(
    'src/platforms/linux/__tests__/clipboard.test.ts',
    'writeLinuxClipboard uses xclip with stdin on X11',
    'Linux clipboard writes through the supported X11 host-tool seam',
  ),
  [C.keyboard]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'the exact-owner runtime fact rejects native keyboard control on every Linux leaf',
  ),
  [C.install]: gap('No Linux-specific application installation command evidence exists yet'),
  [C.reinstall]: gap('No Linux-specific application reinstallation command evidence exists yet'),
  [C.push]: gap('No Linux-specific push delivery command evidence exists yet'),
  [C.triggerAppEvent]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'the exact-owner runtime fact rejects native application event delivery on Linux',
  ),
  [C.open]: live('the existing Linux replay opens gnome-calculator'),
  [C.prepare]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'Linux runtime facts explicitly report Apple runner preparation unavailable',
  ),
  [C.batch]: commandEvidenceLive('the command-evidence lane executes two live Linux read steps'),
  [C.close]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario closes the calculator and observes the desktop close call',
  ),
  [C.snapshot]: live('the existing Linux replay captures the calculator accessibility tree'),
  [C.diff]: commandEvidenceLive(
    'the command-evidence lane observes a non-empty calculator snapshot mutation',
  ),
  [C.wait]: live('the existing Linux replay waits for an observable calculator landmark'),
  [C.alert]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'the exact-owner runtime fact rejects native alert handling on Linux',
  ),
  [C.settings]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'the exact-owner runtime fact rejects native device settings on Linux',
  ),
  // R61: no owner fact refuses this command on Linux — its whole device work is one bound
  // `tapPoint`, the same cell the live click leg uses — so it now runs and reports truthfully
  // that no React Native overlay is present on a GTK desktop.
  [C.reactNative]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'React Native overlay dismissal binds the same desktop tap the press leg does',
  ),
  [C.record]: gap('No Linux-specific recording command evidence exists yet'),
  [C.trace]: gap('No Linux-specific trace command evidence exists yet'),
  [C.find]: commandEvidenceLive('the command-evidence lane resolves a live AT-SPI role match'),
  // Promoted from command-contract to live: the desktop replay now clicks a resolved digit
  // button on real Linux hardware and the downstream wait only passes if the click landed
  // (formerly missed — AT-SPI extents were computed screen-absolute-wrong under GTK4; see
  // linux/atspi-dump.py).
  [C.click]: live('the Linux desktop replay clicks a resolved calculator digit button'),
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
  [C.hover]: contract(
    'packages/platform-linux/src/runtime.ts',
    'hover: unsupportedPlatformLeaf',
    'the Linux runtime fact rejects pointer-only hover input',
  ),
  [C.press]: contract(
    LINUX_PROVIDER_EVIDENCE.path,
    LINUX_PROVIDER_EVIDENCE.test,
    'Linux provider scenario presses a snapshot ref and coordinate target',
  ),
  // Promoted from command-contract to live: GTK4 gnome-calculator's entry previously exposed no
  // Text-interface content to selectors (a PyGObject binding call-pattern bug — see
  // linux/atspi-dump.py), so no tree-level assertion could hold. Fixed, so the desktop replay's
  // typed calculation now has a real wait assertion on the computed result.
  [C.type]: live('the Linux desktop replay types a calculation and its result is selectable'),
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
  [C.tvRemote]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'the exact-owner runtime fact rejects TV remote input on every Linux leaf',
  ),
  [C.orientation]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'the exact-owner runtime fact rejects native orientation changes on every Linux leaf',
  ),
  [C.scroll]: contract(
    'src/platforms/linux/__tests__/input-actions.test.ts',
    'scrollLinux uses ydotool mousemove --wheel for vertical scroll',
    'Linux scroll dispatch uses the Wayland ydotool wheel primitive',
  ),
  [C.swipe]: commandEvidenceLive('the command-evidence lane dispatches a coordinate swipe'),
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
  [C.appSwitcher]: contract(
    LINUX_RUNTIME_EVIDENCE.path,
    LINUX_RUNTIME_EVIDENCE.test,
    'the exact-owner runtime fact rejects native app-switcher navigation on Linux',
  ),
  [C.installFromSource]: gap('No Linux-specific source-install command evidence exists yet'),
} satisfies Record<PublicCommand, LinuxPlatformCoverageEntry>;

export const LINUX_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY = buildCoverageClassificationSummary(
  Object.values(LINUX_PLATFORM_COVERAGE),
);

export function liveCommandsForLinuxReplay(): PublicCommand[] {
  return Object.entries(LINUX_PLATFORM_COVERAGE)
    .filter(
      ([, entry]) => entry.level === 'live' && entry.owner.path === LINUX_REPLAY_EVIDENCE.path,
    )
    .map(([command]) => command as PublicCommand);
}

export function liveCommandsForLinuxCommandEvidence(): PublicCommand[] {
  return Object.entries(LINUX_PLATFORM_COVERAGE)
    .filter(
      ([, entry]) => entry.level === 'live' && entry.owner.path === LINUX_COMMAND_EVIDENCE.path,
    )
    .map(([command]) => command as PublicCommand);
}
