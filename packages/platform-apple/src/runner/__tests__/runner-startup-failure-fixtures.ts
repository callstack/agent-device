import { AppError } from '@agent-device/kernel/errors';
import type {
  IosDeveloperDiskImageState,
  IosDeveloperModeState,
  RunnerDeviceReadinessFailureReason,
  RunnerStartupFailureReason,
} from '../runner-contract.ts';
import { RUNNER_DEVICE_READINESS_FAILURE_REASONS } from '../runner-contract.ts';

/**
 * Recorded startup failures for {@link classifyRunnerStartupFailure} (#2680).
 *
 * Provenance is the point of this file, so it is stated per entry and never as a blanket claim:
 *
 * - `captured` — `output` was pasted from a run, and `command` plus `xcodeVersion` (from
 *   `xcodebuild -version`) were recorded with it by `.device-evidence/CHECKLIST.md`.
 * - `shipped-sniff-trigger` — the substrings a rule matches are the ones shipped in
 *   `resolveSigningFailureHint` before #2680, which is evidence xcodebuild can emit them. The
 *   sentence around them is ours, so `command` and `xcodeVersion` stay unrecorded.
 * - `invented-shape` — no shipped trigger and no capture. The entry exists to exercise a rule and
 *   makes no claim about wording xcodebuild prints.
 *
 * Until Phase B captures the real runs, every entry is `unobserved` for `xcodeVersion` and carries
 * no `command`: an invocation we did not run is not provenance. Nothing in the classifier reads
 * these fields; they exist so a reason can be traced to an observation instead of to a guess.
 */

export type RunnerStartupFailureSite =
  | 'build-for-testing'
  | 'host-dev-tools-security'
  | 'device-readiness';

/**
 * The two states a device reports about itself (#2683), in the shape `readIosDeviceReadiness`
 * publishes them. They are recorded as states rather than as payload text because the states are the
 * evidence: the payload they came from is captured in
 * `packages/platform-apple/src/core/__tests__/fixtures/ios-device-info-details.json`.
 */
export type IosDeviceReadinessReport = Readonly<{
  developerMode: IosDeveloperModeState;
  developerDiskImage: IosDeveloperDiskImageState;
}>;

/**
 * Whether the text reaches the build catch inside the exec error's `details` (`exec-details`, which
 * is how a non-zero `xcodebuild` arrives) or only in the thrown message (`message-only`, which is
 * how anything the exec layer raised as a plain `Error` arrives after the catch wraps `String(err)`).
 */
export type RunnerStartupFailureCarrier = 'exec-details' | 'message-only';

const UNOBSERVED = 'unobserved';

export type RunnerStartupFailureFixture = Readonly<{
  /** Stable name for a focused test or a review comment. */
  id: string;
  /** The reason this output must reach the caller with. */
  reason: RunnerStartupFailureReason;
  /** Which throw site receives this output. */
  site: RunnerStartupFailureSite;
  carrier?: RunnerStartupFailureCarrier;
  /** The invocation that produced {@link RunnerStartupFailureFixture.output}, once one is recorded. */
  command?: string;
  /** `xcodebuild -version` recorded from that run, or `unobserved`. */
  xcodeVersion: string;
  provenance: 'captured' | 'shipped-sniff-trigger' | 'invented-shape';
  /** The tool's own stdout/stderr. */
  output: string;
  /** The argv the exec reported, which is never evidence of a cause (#2680). */
  args?: readonly string[];
  /** The device's own states, which is the evidence the `device-readiness` site reads. */
  deviceReport?: IosDeviceReadinessReport;
  /** What the pending capture still has to show, and how to reach it. */
  note?: string;
}>;

/** The one command the `device-readiness` site runs, spelled out by `readIosDeviceReadiness`. */
const DEVICE_INFO_DETAILS_COMMAND =
  'xcrun devicectl device info details --device <udid> --json-output <file> --timeout 10';

export const RUNNER_STARTUP_FAILURE_FIXTURES: readonly RunnerStartupFailureFixture[] = [
  {
    id: 'bundle-id-registration-failed',
    reason: 'bundle_identifier_already_registered',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'shipped-sniff-trigger',
    output:
      "error: Failed registering bundle identifier \"com.yourname.agentdevice.runner\" with the developer portal (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Capture with AGENT_DEVICE_IOS_BUNDLE_ID set to an identifier already registered by another team, and record the `xcodebuild -version` of the machine.',
  },
  {
    id: 'app-id-not-available',
    reason: 'bundle_identifier_already_registered',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'shipped-sniff-trigger',
    output:
      "error: App Identifier 'com.yourname.agentdevice.runner' is not available (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'The second shape of the same cause: no "failed registering" line, so only the two-part "app identifier" + "not available" trigger can name it. Trimmed to the shipped trigger; the real sentence is still unrecorded.',
  },
  {
    id: 'requires-development-team',
    reason: 'signing_no_development_team',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'shipped-sniff-trigger',
    output:
      "error: Signing for \"AgentDeviceRunner\" requires a development team (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Capture with AGENT_DEVICE_IOS_TEAM_ID unset on a signed-in-but-team-less account.',
  },
  {
    id: 'requires-development-team-message-only',
    reason: 'signing_no_development_team',
    site: 'build-for-testing',
    carrier: 'message-only',
    xcodeVersion: UNOBSERVED,
    provenance: 'shipped-sniff-trigger',
    output:
      "error: Signing for \"AgentDeviceRunner\" requires a development team (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')",
    note: 'Same text arriving in the thrown message instead of the exec details: the catch wraps a non-AppError with String(err), and the rule still has to see it.',
  },
  {
    id: 'no-profiles-for-bundle-id',
    reason: 'signing_provisioning_profile_missing',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'shipped-sniff-trigger',
    output:
      "error: No profiles for 'com.yourname.agentdevice.runner' were found (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Capture with AGENT_DEVICE_IOS_PROVISIONING_PROFILE naming a profile that is not installed.',
  },
  {
    id: 'conflicting-provisioning-settings',
    reason: 'build_failed_unclassified',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "error: \"AgentDeviceRunner\" has conflicting provisioning settings (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Names a profile while saying the settings disagree, so the profile row must not win. No reason is claimed until a capture proves which lever clears it.',
  },
  {
    id: 'code-signing-required',
    reason: 'signing_unspecified',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'shipped-sniff-trigger',
    output:
      "error: Code signing is required for product type 'Application' (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Signing is named and nothing above it is: the reason stays unspecified on purpose.',
  },
  {
    id: 'compile-error',
    reason: 'build_failed_unclassified',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "error: cannot find 'AgentDeviceRunnerCommand' in scope (in target 'AgentDeviceRunnerUITests' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Any build failure that names no signing fact must keep the cache-recovery hint.',
  },
  {
    id: 'argv-names-a-provisioning-profile',
    reason: 'build_failed_unclassified',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "error: cannot find 'AgentDeviceRunnerCommand' in scope (in target 'AgentDeviceRunnerUITests' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    args: [
      'build-for-testing',
      'PROVISIONING_PROFILE_SPECIFIER=match-development',
      'Provisioning Profile: match-development',
    ],
    note: 'The argv we were asked to run is not xcodebuild evidence: a caller who pinned a profile still gets cache-recovery advice for a compile error (#2680).',
  },
  {
    id: 'device-mode-off',
    reason: 'device_developer_mode_disabled',
    site: 'device-readiness',
    command: DEVICE_INFO_DETAILS_COMMAND,
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output: '"developerModeStatus" : "disabled",\n"ddiServicesAvailable" : false,\n',
    deviceReport: { developerMode: 'disabled', developerDiskImage: 'unavailable' },
    note: 'Both states bad, which is what a phone with the toggle off looks like: the toggle has to be the reason named, since it explains the image. No device with the toggle off has been captured.',
  },
  {
    id: 'device-disk-image-down',
    reason: 'device_developer_disk_image_unavailable',
    site: 'device-readiness',
    command: DEVICE_INFO_DETAILS_COMMAND,
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output: '"developerModeStatus" : "enabled",\n"ddiServicesAvailable" : false,\n',
    deviceReport: { developerMode: 'enabled', developerDiskImage: 'unavailable' },
    note: 'The decisive pairing, and the one #2682 used to answer with Developer Mode advice: the toggle is on and only the image is down. The enabled half is the captured state; a device waiting on device support has not been captured.',
  },
  {
    id: 'devtools-security-disabled',
    reason: 'devtools_security_developer_mode_disabled',
    site: 'host-dev-tools-security',
    command: 'DevToolsSecurity -status',
    xcodeVersion: UNOBSERVED,
    provenance: 'shipped-sniff-trigger',
    output: 'Developer mode is currently disabled for development tools.\n',
    note: "Host-side refusal. It says nothing about the device's Developer Mode toggle (#2683 reads that).",
  },
];

export function buildForTestingFixtures(): RunnerStartupFailureFixture[] {
  return RUNNER_STARTUP_FAILURE_FIXTURES.filter((fixture) => fixture.site === 'build-for-testing');
}

export function buildFixtureById(id: string): RunnerStartupFailureFixture {
  const fixture = RUNNER_STARTUP_FAILURE_FIXTURES.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`no startup failure fixture records ${id}`);
  return fixture;
}

/** A recorded device report, narrowed to the reasons the device can name about itself. */
export type IosDeviceReadinessFixture = RunnerStartupFailureFixture & {
  reason: RunnerDeviceReadinessFailureReason;
  site: 'device-readiness';
  deviceReport: IosDeviceReadinessReport;
};

/** The recorded device reports, which the runner preflight reads instead of any tool's text. */
export function deviceReadinessFixtures(): IosDeviceReadinessFixture[] {
  return RUNNER_STARTUP_FAILURE_FIXTURES.filter(isDeviceReadinessFixture);
}

function isDeviceReadinessFixture(
  fixture: RunnerStartupFailureFixture,
): fixture is IosDeviceReadinessFixture {
  return (
    fixture.site === 'device-readiness' &&
    fixture.deviceReport !== undefined &&
    (RUNNER_DEVICE_READINESS_FAILURE_REASONS as readonly string[]).includes(fixture.reason)
  );
}

/**
 * What the exec layer hands the build-failure catch: for `exec-details` a COMMAND_FAILED carrying
 * the tool's output and the argv in `details` (`execFailureDetails` shape), and for `message-only`
 * the plain `Error` the catch turns into `new AppError('COMMAND_FAILED', String(error))`.
 */
export function buildForTestingExecFailure(
  fixture: RunnerStartupFailureFixture,
  exitCode = 65,
): unknown {
  if ((fixture.carrier ?? 'exec-details') === 'message-only') {
    return new Error(`xcodebuild exited with code ${exitCode}: ${fixture.output}`);
  }
  return new AppError('COMMAND_FAILED', `xcodebuild exited with code ${exitCode}`, {
    stdout: fixture.output,
    stderr: '',
    exitCode,
    processExitError: true,
    cmd: 'xcodebuild',
    args: fixture.args ?? ['build-for-testing'],
  });
}
