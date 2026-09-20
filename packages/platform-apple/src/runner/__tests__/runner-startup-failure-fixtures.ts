import { AppError } from '@agent-device/kernel/errors';
import type { RunnerStartupFailureReason } from '../runner-contract.ts';

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
 */

export type RunnerStartupFailureSite = 'build-for-testing' | 'host-dev-tools-security';

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
  /** What the pending capture still has to show, and how to reach it. */
  note?: string;
}>;

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
