import { AppError } from '@agent-device/kernel/errors';
import type {
  RunnerDeviceReadinessFailureReason,
  RunnerStartupFailureReason,
} from '../runner-error-classification.ts';
import { RUNNER_DEVICE_READINESS_FAILURE_REASONS } from '../runner-error-classification.ts';
import type { IosPhysicalDeviceRunnerControl } from '../../core/physical-device-routing.ts';
import { XCODE_26_2_SIMCTL_SHIM } from '../../core/__tests__/xcrun-shim-fixtures.ts';

/**
 * Recorded startup failures for {@link classifyRunnerStartupFailure} (#2680).
 *
 * Provenance is the point of this file, so it is stated per entry and never as a blanket claim:
 *
 * - `captured` — `output` was pasted from a run, and `command` plus `xcodeVersion` (from
 *   `xcodebuild -version`) were recorded with it by `.device-evidence/CHECKLIST-runner-failures.md`.
 * - `shipped-sniff-trigger` — the substrings a rule matches are the ones shipped in
 *   `resolveSigningFailureHint` before #2680, which is evidence xcodebuild can emit them. The
 *   sentence around them is ours, so `command` and `xcodeVersion` stay unrecorded.
 * - `invented-shape` — no shipped trigger and no capture. The entry exists to exercise a rule and
 *   makes no claim about wording xcodebuild prints.
 *
 * Until Phase B captures the real runs, every entry is `unobserved` for `xcodeVersion` and carries
 * no `command`: an invocation we did not run is not provenance. Nothing in the classifier reads
 * these fields; they exist so a reason can be traced to an observation instead of to a guess.
 *
 * Blocked on the host, not unexamined. One Phase B run on `thymikee-iphone` / Xcode 26.2 settled the
 * shape question these rows were held on — `No profiles for '<id>' were found` arrives as one long
 * `error:` line, not a wrapped one — and `no-profiles-for-bundle-id` below is now `captured`. The
 * rest are gated on an Apple account this machine does not have, and they need it for the same
 * reason: the build either signs successfully or dies before reaching the diagnostic a row keys on.
 * `requires-development-team` and `requires-development-team-message-only` need an account that is
 * signed in with no development team; automatic signing resolves the team from any installed
 * identity, so unsetting `AGENT_DEVICE_IOS_TEAM_ID` builds successfully.
 * `bundle-id-registration-failed`, `app-id-not-available` and the `bundle_identifier_unavailable`
 * rule it feeds, plus `profile-does-not-cover-app-id` (`Provisioning profile` + `doesn't include`)
 * and `profile-expired` (`Provisioning profile` + `has expired`), all need a profile and an app id
 * already claimed by someone else: against a working account `-allowProvisioningUpdates` registers
 * or repairs the id, so the conflict text is never printed and the build reaches signing success.
 * Each of those rows is therefore uninducible here rather than untested, and none of them should be
 * read as waiting on effort this machine can supply.
 */

export type RunnerStartupFailureSite =
  | 'build-for-testing'
  | 'host-dev-tools-security'
  | 'device-readiness'
  | 'xctest-device-set-redirect';

/**
 * The two states a device reports about itself (#2683), in the shape `readIosDeviceReadiness`
 * publishes them. They are recorded as states rather than as payload text because the states are the
 * evidence: the payload they came from is captured in
 * `packages/platform-apple/src/core/__tests__/fixtures/ios-device-info-details.json`.
 */
/**
 * The two states a device payload carries. `remedies` is left out on purpose: that wording is ours and
 * arrives on the report, so a fixture that recorded it would be recording our own advice as if the
 * phone had said it.
 */
export type IosDeviceReadinessReport = Omit<
  Extract<
    Awaited<ReturnType<IosPhysicalDeviceRunnerControl['readDeviceReadiness']>>,
    {
      available: true;
    }
  >,
  'available' | 'remedies'
>;

/**
 * Whether the text reaches the build catch inside the exec error's `details` (`exec-details`, which
 * is how a non-zero `xcodebuild` arrives) or only in the thrown message (`message-only`, which is
 * how anything the exec layer raised as a plain `Error` arrives after the catch wraps `String(err)`).
 */
export type RunnerStartupFailureCarrier = 'exec-details' | 'message-only' | 'host-timeout';

const UNOBSERVED = 'unobserved';

export type RunnerStartupFailureFixture = Readonly<{
  /** Stable name for a focused test or a review comment. */
  id: string;
  /** The reason this output must reach the caller with. */
  reason: RunnerStartupFailureReason;
  /** Which throw site receives this output. */
  site: RunnerStartupFailureSite;
  carrier?: RunnerStartupFailureCarrier;
  /** The deadline the host killed this command at, for the `host-timeout` carrier. */
  hostTimeoutMs?: number;
  /** The invocation that produced {@link RunnerStartupFailureFixture.output}, once one is recorded. */
  command?: string;
  /** `xcodebuild -version` recorded from that run, or `unobserved`. */
  xcodeVersion: string;
  provenance: 'captured' | 'shipped-sniff-trigger' | 'invented-shape';
  /** The tool's own stdout/stderr. */
  output: string;
  /** The argv the exec reported, which is never evidence of a cause (#2680). */
  args?: readonly string[];
  /**
   * The device's own states. On the `device-readiness` site this is the evidence the preflight reads;
   * on a `build-for-testing` entry it is what the startup carried onto that build, which is the pairing
   * the corroborated disk-image reason depends on (#2683).
   */
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
    id: 'app-identifier-and-availability-in-different-lines',
    reason: 'build_failed_unclassified',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "error: App Identifier 'com.yourname.agentdevice.runner' is invalid (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\nnote: The simulator device is not available for this destination\n** TEST BUILD FAILED **\n",
    note: 'The same cross-line hazard the profile rows gave up (#2688 review): one line faults the identifier and another says something is not available, and neither line pairs them. The reason needs both in one sentence, which is what `app-id-not-available` records.',
  },
  {
    id: 'no-profiles-for-bundle-id',
    reason: 'signing_provisioning_profile_missing',
    site: 'build-for-testing',
    command:
      'agent-device prepare ios-runner --platform ios --device <iPhone> --json  # AGENT_DEVICE_IOS_TEAM_ID=ZZZZZZZZZZ, fresh AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH',
    xcodeVersion: 'Xcode 26.2 / Build version 17C52',
    provenance: 'captured',
    output:
      "/Users/thymikee/.t3/worktrees/agent-device/apex-2680/apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj: error: No Accounts: Add a new account in Accounts settings. (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n/Users/thymikee/.t3/worktrees/agent-device/apex-2680/apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj: error: No profiles for 'com.callstack.agentdevice.runner' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'com.callstack.agentdevice.runner'. (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n",
    note: 'Captured on `thymikee-iphone`, iPhone 17 Pro, iOS 27.0. Reached by pointing `AGENT_DEVICE_IOS_TEAM_ID` at a team with no certificate on a machine that is not signed into Xcode, with a fresh derived path so no cached artifact short-circuits the build. One `error:` line per target: the phrase the rule matches is not wrapped, which is the evidence the sibling rows were held for. Note the `No Accounts` line above it names nothing the rule reads — the profile row wins on its own line.',
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
  // Narrowed profile rows (#2688 review): each of these requires the profile AND the complaint Xcode
  // attaches to it. The bare phrase alone was the shipped sniffer's trigger and is not evidence, so the
  // negative entry below is what keeps those rows honest.
  {
    id: 'profile-xcode-signing-error',
    reason: 'signing_provisioning_profile_missing',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "error: Provisioning profile \"match-development\" is not a valid provisioning profile (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\nError Domain=IDEProvisioningErrorDomain Code=17 \"Provisioning profile 'match-development' is not a valid provisioning profile.\"\n** TEST BUILD FAILED **\n",
    note: "Xcode repeats the profile inside the same line as its IDEProvisioningErrorDomain diagnostics, which is what the row reads: domain on one line and profile on another is two facts, not one complaint. Sentence and domain code are our reconstruction; Phase B capture has to record the real wording and this entry's xcodeVersion.",
  },
  {
    id: 'profile-does-not-cover-app-id',
    reason: 'signing_provisioning_profile_missing',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "error: Provisioning profile \"match-development\" doesn't include application identifier 'com.yourname.agentdevice.runner' (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'The installed profile that does not cover this app id. Advice is the same lever, so the same reason is published; wording unrecorded.',
  },
  {
    id: 'profile-expired',
    reason: 'signing_provisioning_profile_missing',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "error: Provisioning profile \"match-development\" has expired (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Reinstalling the same profile clears nothing; "a valid profile" in the hint is the operative word. Wording unrecorded.',
  },
  {
    id: 'profile-mentioned-while-compiling',
    reason: 'build_failed_unclassified',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "note: Using provisioning profile \"match-development\" to sign the app bundle (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\nerror: cannot find 'AgentDeviceRunnerCommand' in scope (in target 'AgentDeviceRunnerUITests' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'The hazard the bare `provisioning profile` trigger carried (#2688 review): a failing build can print the profile it used while the failure is a compile error. A benign mention must keep cache-recovery advice; it also says nothing Xcode calls code signing, which is its own honest row.',
  },
  {
    id: 'profile-note-above-an-expired-certificate',
    reason: 'build_failed_unclassified',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "note: Using provisioning profile \"match-development\" to sign the app bundle (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\nwarning: The certificate \"Apple Development: Example Dev (ABCD1234)\" has expired.\nerror: cannot find 'AgentDeviceRunnerCommand' in scope (in target 'AgentDeviceRunnerUITests' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'The cross-line hazard a whole-log AND cannot see (#2688 review): a benign profile note three lines above an unrelated expired-certificate warning. Both phrases are in the captured log and neither qualifies the other, so the profile stays unclassified and the reader keeps cache-recovery advice rather than being sent to replace a profile that is fine.',
  },
  {
    id: 'unclassified-build-on-device-with-image-down',
    reason: 'device_developer_disk_image_unavailable',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "error: cannot find 'AgentDeviceRunnerCommand' in scope (in target 'AgentDeviceRunnerUITests' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    deviceReport: { developerMode: 'enabled', developerDiskImage: 'unavailable' },
    note: 'The corroborated pairing (#2683 review): a build that names no cause, on a phone core read directly as reporting its image down. Naming the image beats cache-recovery advice; the state also travels as details.developerDiskImage.',
  },
  {
    id: 'host-killed-build-on-device-with-image-down',
    reason: 'build_failed_unclassified',
    site: 'build-for-testing',
    carrier: 'host-timeout',
    hostTimeoutMs: 900_000,
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "note: Using target 'AgentDeviceRunner' for build-for-testing\nbuilding project 'AgentDeviceRunner' toward destination 'Example iPhone'\nCompileSwiftFile normal (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n",
    deviceReport: { developerMode: 'enabled', developerDiskImage: 'unavailable' },
    note: "The build the host killed at its own `buildTimeoutMs`, on a phone reporting its image down (#2690 review). A slow build and a build the device refuses are different facts, and the second one is not available from a command that never finished: the reason stays unclassified with cache-recovery advice, and the image state rides along as a detail only. The shape follows the exec layer's timeout error; the 15-minute budget and the partial log are ours, so no capture stands behind them.",
  },
  {
    id: 'conflicting-settings-on-device-with-image-down',
    reason: 'build_failed_unclassified',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'invented-shape',
    output:
      "error: \"AgentDeviceRunner\" has conflicting provisioning settings (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    deviceReport: { developerMode: 'enabled', developerDiskImage: 'unavailable' },
    note: 'The pairing that made the enrichment key on "did a row match" rather than on the unclassified reason (#2690 review): a just-rebooted phone reports its image down while the failure is a settings disagreement a row already looked at and declined to name. The row answer wins and the cache-recovery hint stays; the image state still rides along as a detail.',
  },
  {
    id: 'team-id-failure-on-device-with-image-down',
    reason: 'signing_no_development_team',
    site: 'build-for-testing',
    xcodeVersion: UNOBSERVED,
    provenance: 'shipped-sniff-trigger',
    output:
      "error: Signing for \"AgentDeviceRunner\" requires a development team (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    deviceReport: { developerMode: 'enabled', developerDiskImage: 'unavailable' },
    note: "A build that named its own cause keeps it: a corroborated device state never overwrites xcodebuild's own sentence (#2683).",
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
    note: 'The decisive pairing, and the one #2682 used to answer with Developer Mode advice: the toggle is on and only the image is down. It is NOT a pre-build refusal (#2683 review): iOS 17+ mounts the image on demand during build and launch, so this report has to survive to a failure — which is what `unclassified-build-on-device-with-image-down` records. The enabled half is captured on some devices; a device waiting on device support has not been captured.',
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
  {
    id: 'xcode-26-2-simctl-shim-first-launch',
    reason: 'xctest_device_set_cleanup_armed',
    site: 'xctest-device-set-redirect',
    command: XCODE_26_2_SIMCTL_SHIM.command,
    xcodeVersion: XCODE_26_2_SIMCTL_SHIM.xcodeVersion,
    provenance: 'captured',
    output: XCODE_26_2_SIMCTL_SHIM.text,
    note: 'The shim text, not tool output: the redirect refuses on what the shim would do, before any xcodebuild runs (#2935). Installed CoreSimulator on that host was 1155.4. The Xcode version was read from its version.plist, not from `xcodebuild -version`.',
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
  if (fixture.carrier === 'host-timeout') {
    // The exec layer's own kill-at-deadline error, which `isCommandTimeoutError` answers for.
    const timeoutMs = fixture.hostTimeoutMs ?? 900_000;
    return new AppError('COMMAND_FAILED', `xcodebuild timed out after ${timeoutMs}ms`, {
      cmd: 'xcodebuild',
      args: fixture.args ?? ['build-for-testing'],
      stdout: fixture.output,
      stderr: '',
      timeoutMs,
    });
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
