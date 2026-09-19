import { AppError } from '@agent-device/kernel/errors';
import type { RunnerStartupFailureReason } from '../runner-contract.ts';

/**
 * Recorded startup failures for {@link classifyRunnerStartupFailure} (#2680).
 *
 * Each entry carries the tool output exactly as it reaches the host, the command that produced it,
 * the Xcode that produced it, and how it got here. `provenance` is what says whether a line was
 * observed or transcribed: an entry stays `inherited-sniff-trigger` until the matching command in
 * `.device-evidence/CHECKLIST.md` is run against real hardware, at which point `output` is replaced
 * with the capture and `provenance` becomes `captured`. Nothing in the classifier reads these
 * fields — they exist so a reason can be traced to an observation instead to a guess.
 */

export type RunnerStartupFailureSite = 'build-for-testing' | 'host-dev-tools-security';

export type RunnerStartupFailureFixture = Readonly<{
  /** The reason this output must reach the caller with. */
  reason: RunnerStartupFailureReason;
  /** Which throw site receives this output. */
  site: RunnerStartupFailureSite;
  /** The invocation that produced {@link RunnerStartupFailureFixture.output}. */
  command: string;
  /** `xcodebuild -version` of the machine that produced it. */
  xcodeVersion: string;
  provenance: 'captured' | 'inherited-sniff-trigger' | 'tool-error-shape';
  /** The tool's own stdout/stderr, kept on one shape so JSON detail matching sees it as the host does. */
  output: string;
  /** What the pending capture still has to show. */
  note?: string;
}>;

/**
 * The `xcodebuild` invocation `buildRunnerXctestrun` issues for a physical iOS device with Automatic
 * Signing and no profile pinned, which is the configuration every signing reason below is about.
 */
const BUILD_FOR_TESTING_COMMAND =
  'xcodebuild build-for-testing -project apple/runner/AgentDeviceRunner/AgentDeviceRunner.xcodeproj ' +
  '-scheme AgentDeviceRunner -parallel-testing-enabled NO -destination generic/platform=iOS ' +
  '-derivedDataPath <derived> -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic ' +
  'DEVELOPMENT_TEAM=<AGENT_DEVICE_IOS_TEAM_ID>';

const OBSERVED_ON = 'Xcode 26.2 (Build 17C52)';

export const RUNNER_STARTUP_FAILURE_FIXTURES: readonly RunnerStartupFailureFixture[] = [
  {
    reason: 'bundle_identifier_already_registered',
    site: 'build-for-testing',
    command: BUILD_FOR_TESTING_COMMAND,
    xcodeVersion: OBSERVED_ON,
    provenance: 'inherited-sniff-trigger',
    output:
      "error: Failed registering bundle identifier \"com.yourname.agentdevice.runner\" with the developer portal: An App ID with Identifier 'com.yourname.agentdevice.runner' is not available. Please enter a different string. (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Capture with AGENT_DEVICE_IOS_BUNDLE_ID set to an identifier already registered by another team.',
  },
  {
    reason: 'bundle_identifier_already_registered',
    site: 'build-for-testing',
    command: BUILD_FOR_TESTING_COMMAND,
    xcodeVersion: OBSERVED_ON,
    provenance: 'tool-error-shape',
    output:
      "error: App Identifier 'com.yourname.agentdevice.runner' is not available. Choose a different App Identifier, or register it in your Apple Developer account before building. (in target 'AgentDeviceRunnerUITests' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'The second shape of the same cause: no "failed registering" line, so only the two-part match can name it.',
  },
  {
    reason: 'signing_no_development_team',
    site: 'build-for-testing',
    command: BUILD_FOR_TESTING_COMMAND,
    xcodeVersion: OBSERVED_ON,
    provenance: 'inherited-sniff-trigger',
    output:
      "error: Signing for \"AgentDeviceRunner\" requires a development team. Select a development team in the Signing & Capabilities editor. (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Capture with AGENT_DEVICE_IOS_TEAM_ID unset on a signed-in-but-team-less account.',
  },
  {
    reason: 'signing_provisioning_profile_missing',
    site: 'build-for-testing',
    command: BUILD_FOR_TESTING_COMMAND,
    xcodeVersion: OBSERVED_ON,
    provenance: 'inherited-sniff-trigger',
    output:
      "error: No profiles for 'com.yourname.agentdevice.runner' were found: Xcode couldn't find any iOS App Development provisioning profiles matching 'com.yourname.agentdevice.runner'. Automatic signing is disabled and unable to generate a profile. To enable automatic signing, pass -allowProvisioningUpdates to xcodebuild. (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Capture with AGENT_DEVICE_IOS_PROVISIONING_PROFILE naming a profile that is not installed.',
  },
  {
    reason: 'signing_style_conflict',
    site: 'build-for-testing',
    command: BUILD_FOR_TESTING_COMMAND,
    xcodeVersion: OBSERVED_ON,
    provenance: 'tool-error-shape',
    output:
      'error: "AgentDeviceRunner" has conflicting provisioning settings. AgentDeviceRunner is automatically signed, but provisioning profile "match-development-com-yourname-agentdevice-runner" has been manually specified. Set the provisioning profile value to "Automatic" in the build settings editor, or switch to manual signing in the Signing & Capabilities editor. (in target \'AgentDeviceRunner\' from project \'AgentDeviceRunner\')\n** TEST BUILD FAILED **\n',
    note: 'New reason: capture the conflicting-settings line before claiming this wording on hardware.',
  },
  {
    reason: 'signing_unspecified',
    site: 'build-for-testing',
    command: BUILD_FOR_TESTING_COMMAND,
    xcodeVersion: OBSERVED_ON,
    provenance: 'inherited-sniff-trigger',
    output:
      "error: Code signing is required for product type 'Application' in SDK 'iOS 26.2' (in target 'AgentDeviceRunner' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Signing is named and nothing above it is: the reason stays unspecified on purpose.',
  },
  {
    reason: 'build_failed_unclassified',
    site: 'build-for-testing',
    command: BUILD_FOR_TESTING_COMMAND,
    xcodeVersion: OBSERVED_ON,
    provenance: 'tool-error-shape',
    output:
      "error: cannot find 'AgentDeviceRunnerCommand' in scope (in target 'AgentDeviceRunnerUITests' from project 'AgentDeviceRunner')\n** TEST BUILD FAILED **\n",
    note: 'Any build failure that names no signing fact must keep the cache-recovery hint.',
  },
  {
    reason: 'devtools_security_developer_mode_disabled',
    site: 'host-dev-tools-security',
    command: 'DevToolsSecurity -status',
    xcodeVersion: OBSERVED_ON,
    provenance: 'inherited-sniff-trigger',
    output: 'Developer mode is currently disabled for development tools.\n',
    note: "Host-side refusal. It says nothing about the device's Developer Mode toggle (#2683 reads that).",
  },
];

export function buildForTestingFixtures(): RunnerStartupFailureFixture[] {
  return RUNNER_STARTUP_FAILURE_FIXTURES.filter((fixture) => fixture.site === 'build-for-testing');
}

/**
 * The error the exec layer hands the build-failure catch when `xcodebuild` exits non-zero: a
 * COMMAND_FAILED whose message is the exec's own and whose tool output sits in `details`, which is
 * exactly why the rules below read details text and not only the message.
 */
export function buildForTestingExecError(
  fixture: Pick<RunnerStartupFailureFixture, 'output'>,
  exitCode = 65,
): AppError {
  return new AppError('COMMAND_FAILED', 'xcodebuild exited with code 65', {
    stdout: fixture.output,
    stderr: '',
    exitCode,
    processExitError: true,
    cmd: 'xcodebuild',
    args: ['build-for-testing'],
  });
}
