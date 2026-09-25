import {
  AppError,
  isRequestCanceledDetails,
  type AppErrorCode,
  type AppErrorDetails,
} from '@agent-device/kernel/errors';
import {
  isCommandTimeoutError,
  type IosDeveloperDiskImageState,
  type IosDeveloperModeState,
} from './host.ts';
import { MAIN_THREAD_TIMEOUT_RUNNER_CODE, RUNNER_BUSY_RUNNER_CODE } from './runner-contract.ts';

export const RUNNER_CACHE_RECOVERY_HINT =
  'If runner build products look stale or corrupted, run `pnpm clean:xcuitest` in a local checkout, or remove ~/.agent-device/apple-runner/derived, then retry.';

/**
 * Details evidence a rule requires beyond code and message. A predicate rather than a
 * fixed vocabulary because the useful evidence is a shape: a recorded deadline, a
 * preflight marker, a runner error code. Every predicate below names one.
 */
type RunnerErrorDetailsMatch = (details: AppErrorDetails) => boolean;

/**
 * Why agent-device's own runner connect path gave up, published in
 * `details.runnerConnectFailureReason` by the error that path throws. It sits beside
 * `details.reason` rather than in it: on the refused-connection and early-exit failures
 * `reason` already carries the `BootFailureReason` the caller's hint answers.
 */
export type RunnerConnectFailureReason =
  | 'xcodebuild_exited_early'
  | 'runner_connect_refused'
  | 'runner_endpoint_probe_exhausted';

export function runnerConnectFailureDetails(reason: RunnerConnectFailureReason): {
  runnerConnectFailureReason: RunnerConnectFailureReason;
} {
  return { runnerConnectFailureReason: reason };
}

type RunnerErrorMatch = {
  /** Required `AppError.code`; absent = any AppError. */
  code?: AppErrorCode;
  /**
   * Every entry must appear in the lowercased message. Only for text a foreign runtime or tool
   * wrote, which `asAppError` copies into the message verbatim; a failure agent-device produces
   * publishes a typed detail instead, and its rule keys on that.
   */
  foreignMessageIncludesAll?: readonly string[];
  /**
   * Every entry must appear in the lowercased {@link runnerToolText}: our message plus the tool's
   * own `stdout`/`stderr`. Nothing else in `details` is read, so the argv we were asked to run and
   * the verdict this classifier already published can never carry a rule (#2680).
   */
  toolTextIncludesAll?: readonly string[];
  /**
   * Every entry must appear in the SAME line of the lowercased {@link runnerToolText} (#2688 review).
   * {@link RunnerErrorMatch.toolTextIncludesAll} proves only that two phrases exist somewhere in a
   * captured log, which is a weaker claim than one phrase qualifying the other: a note about the
   * profile the build used, three lines above an unrelated expired-certificate warning, says nothing
   * about the profile. A row whose evidence is a noun and its complaint asks for both on one line.
   */
  toolTextLineIncludesAll?: readonly string[];
  /** Required details evidence beyond code/message. */
  details?: RunnerErrorDetailsMatch;
};

/**
 * The runner refused the command before running it while abandoned main-thread work drains (#1105).
 * A resend keys on this code, never on `details.retriable`: that flag tells a caller's poll to try
 * again, and its other producers (a not-running app, a spent startup budget, an unavailable
 * toolchain probe, an external provider) must not be resent inside one request.
 */
const hasRunnerBusyCode: RunnerErrorDetailsMatch = (details) =>
  details.runnerErrorCode === RUNNER_BUSY_RUNNER_CODE;
/**
 * The host's own `DevToolsSecurity -status` read, published as typed details by the probe that
 * takes it. The build-failure rule below keys on this field and never on the probe's message, so
 * an error that merely says developer mode is disabled cannot be read as a host refusal (#2680).
 */
const hasDevToolsSecurityStatus: RunnerErrorDetailsMatch = (details) =>
  typeof details.devToolsSecurityStatus === 'string';
/** The failed xcodebuild phase resolved its destination in a scoped simulator set. */
const hasSimulatorSetPath: RunnerErrorDetailsMatch = (details) =>
  typeof details.simulatorSetPath === 'string';
const hasUsbmuxDeviceUnattached: RunnerErrorDetailsMatch = (details) =>
  details.usbmuxDeviceAttached === false;
const hasRunnerConnectFailureReason =
  (reason: RunnerConnectFailureReason): RunnerErrorDetailsMatch =>
  (details) =>
    details.runnerConnectFailureReason === reason;
/**
 * The preflight marks whatever it was waiting on when it stopped, and one of the things it waits on
 * is a caller that stopped waiting. A canceled request is not a wedged runner: the restart this
 * marker authorises would boot a runner for a command nobody is going to send again. Every abort in
 * the connect loop normalizes to the typed canceled reason before it reaches here.
 */
const hasReadinessPreflightFailure: RunnerErrorDetailsMatch = (details) =>
  details.runnerReadinessPreflightFailed === true && !isRequestCanceledDetails(details);

type RunnerErrorVerdicts = {
  /**
   * isRetryableRunnerError: worth a same-session resend, either a transport failure or a structured
   * refusal that executed nothing. Whether a lost response needs status recovery is a separate
   * question ({@link isStructuredRunnerFailure}).
   */
  retryable?: boolean;
  /** isRunnerBusyError: the runner refused fast while abandoned main-thread work drains. */
  drainResend?: boolean;
  /** shouldRetryRunnerConnectError: connect loop may keep waiting for the runner. */
  connectRetry?: boolean;
  /** Session-fatal classification: invalidate the cached runner session with this reason. */
  sessionFatalReason?: string;
  /** Connect-shaped failure before the command was sent: restart the session and replay. */
  restartBeforeSend?: boolean;
  /** Readiness preflight gave up before the command was written: restart the session and replay. */
  restartAfterReadinessPreflight?: boolean;
  /** The runner never accepted a connection, so the restored artifact itself is suspect. */
  artifactSuspect?: boolean;
};

/**
 * The two device-readiness members (#2683): what the iPhone itself reports through
 * `devicectl device info details`, not what another tool's output implies about it. They are listed
 * apart because they are the members {@link classifyRunnerStartupFailure} does NOT produce — no
 * xcodebuild or host-tool text establishes them, and the code that reads the device publishes them
 * with the hint beside it. The two reach the caller at different moments, which is the whole
 * asymmetry of #2683: a disabled Developer Mode toggle refuses the run up front, while an unavailable
 * developer disk image is published onto a build that named no cause of its own, because iOS 17+
 * mounts that image on demand during build and launch. A connect-stage failure always claims a cause
 * of its own (`IOS_RUNNER_CONNECT_TIMEOUT` unless a provisioning row matches first), so there the
 * image state travels only as `details.developerDiskImage`, and
 * `device_developer_disk_image_unavailable` is published only from the startup build catch.
 */
export const RUNNER_DEVICE_READINESS_FAILURE_REASONS = [
  'device_developer_mode_disabled',
  'device_developer_disk_image_unavailable',
] as const;

/**
 * Why the Apple runner could not reach the point of serving a command (#2680). Published in
 * `details.reason` on the `COMMAND_FAILED` every one of these paths throws, so a caller branches
 * on the reason instead of matching prose; the hint that answers it travels with it in
 * {@link RUNNER_ERROR_RULES}.
 *
 * This is the vocabulary #2683 adds the device-readiness members to (Developer Mode and developer
 * disk image state read from the device itself), which is why it is keyed on startup rather than on
 * `xcodebuild`: an iPhone that refuses the runner for reasons other than signing stops the runner
 * before a build is ever the question.
 *
 * Placement: here beside the rules that produce it, not in `@agent-device/contracts`. Every member
 * names a verdict an Apple runner path reaches, while `contracts` carries shapes several surfaces
 * answer with (`InfrastructureBootFailureReason`, which both simulator and device boot use).
 * Nothing outside this package publishes or consumes this enum, and one declaration is the only way
 * a row and its reason cannot disagree.
 */
export const RUNNER_STARTUP_FAILURE_REASONS = [
  'bundle_identifier_already_registered',
  'signing_no_development_team',
  'signing_provisioning_profile_missing',
  'signing_unspecified',
  'devtools_security_developer_mode_disabled',
  'simulator_set_destination_not_found',
  ...RUNNER_DEVICE_READINESS_FAILURE_REASONS,
  'build_failed_unclassified',
] as const;

export type RunnerStartupFailureReason = (typeof RUNNER_STARTUP_FAILURE_REASONS)[number];

/** The device-readiness subset, typed from the one list above. */
export type RunnerDeviceReadinessFailureReason =
  (typeof RUNNER_DEVICE_READINESS_FAILURE_REASONS)[number];

/**
 * The reason a startup failure carries when no rule proves a cause. Its hint is deliberately the
 * cache-recovery advice rather than anything about signing: an unclassified build is not evidence of
 * a signing problem.
 */
export const RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON: RunnerStartupFailureReason =
  'build_failed_unclassified';

type RunnerErrorRule = {
  /** Stable rule name for tests and diagnostics. */
  reason: string;
  match: RunnerErrorMatch;
  verdicts: RunnerErrorVerdicts;
  /**
   * Set on the rules that also classify why the runner could not start (#2680). Rules like these
   * define no recovery verdicts for a runner that never came up — there is no session to invalidate
   * and nothing was sent to resend — so the axes stay empty and the row carries only reason plus
   * hint. Several rows may name one reason (bundle-identifier registration fails in two shapes),
   * and the classifier takes the first match, which is why specific rows precede generic ones.
   */
  buildFailure?: {
    reason: RunnerStartupFailureReason;
    hint: string;
  };
};

/**
 * The advice the provisioning-profile rows share (#2688). Named once so the three rows that require a
 * different complaint cannot drift into three different fixes for one lever.
 */
const PROFILE_UNUSABLE: RunnerErrorRule['buildFailure'] = {
  reason: 'signing_provisioning_profile_missing',
  hint: 'Install/select a valid iOS provisioning profile, or set AGENT_DEVICE_IOS_PROVISIONING_PROFILE.',
};

/**
 * The one declaration of runner error classes (#1631), mirroring
 * RUNNER_COMMAND_TRAITS' role for commands: every recovery predicate
 * below derives from this table instead of keeping its own substring chain,
 * and since #2680 so does the one classification of startup failures — a row
 * carries recovery verdicts, a `buildFailure` reason and hint, or both.
 * Per axis, the FIRST matching rule that defines the axis wins — which is why
 * `usbmux_device_unattached` sits first (retrying cannot attach a cable, and its
 * typed verdict carries the recovery hint a generic connect failure would replace).
 */
export const RUNNER_ERROR_RULES: readonly RunnerErrorRule[] = [
  {
    reason: 'usbmux_device_unattached',
    match: { code: 'DEVICE_NOT_FOUND', details: hasUsbmuxDeviceUnattached },
    verdicts: { connectRetry: false },
  },
  {
    // Nothing ran: the runner answered before dispatching the command (#1105).
    reason: 'runner_busy_refusal',
    match: { code: 'COMMAND_FAILED', details: hasRunnerBusyCode },
    verdicts: { retryable: true, connectRetry: true, drainResend: true },
  },
  {
    // Says `artifactSuspect: false` on purpose: a boot that cannot compile is not cured by wiping
    // derived data.
    reason: 'xcodebuild_exited_early',
    match: {
      code: 'COMMAND_FAILED',
      details: hasRunnerConnectFailureReason('xcodebuild_exited_early'),
    },
    verdicts: { retryable: false, connectRetry: false, artifactSuspect: false },
  },
  {
    // A device still mid-attachment is not a runner we can talk to yet, and waiting on
    // it inside this request is what the caller's own retry is for.
    reason: 'device_busy_connecting',
    // Xcode/CoreDevice text: "Device is busy (Connecting to <device>)".
    match: { code: 'COMMAND_FAILED', foreignMessageIncludesAll: ['device is busy', 'connecting'] },
    verdicts: { retryable: false, connectRetry: false },
  },
  {
    // The marker is the whole fact: the preflight gave up before the command was written, so
    // replaying it cannot duplicate anything. It is asked for alone because the preflight fails in
    // whatever shape the connect loop ended with — a refusal, an exhausted probe, a killed
    // fallback — and a rule that also required a recorded budget would fire on only some of them.
    reason: 'runner_readiness_preflight_failed',
    match: { code: 'COMMAND_FAILED', details: hasReadinessPreflightFailure },
    verdicts: { restartAfterReadinessPreflight: true },
  },
  {
    reason: 'runner_connect_refused',
    match: {
      code: 'COMMAND_FAILED',
      details: hasRunnerConnectFailureReason('runner_connect_refused'),
    },
    verdicts: {
      retryable: true,
      connectRetry: true,
      restartBeforeSend: true,
      artifactSuspect: true,
    },
  },
  {
    // Every endpoint answered and none of them had a runner: with a restored artifact
    // in hand, that artifact is the common cause.
    reason: 'runner_endpoint_probe_exhausted',
    match: {
      code: 'COMMAND_FAILED',
      details: hasRunnerConnectFailureReason('runner_endpoint_probe_exhausted'),
    },
    verdicts: { artifactSuspect: true },
  },
  {
    reason: 'fetch_failed',
    // Node's fetch (undici) rejects a failed request with TypeError "fetch failed".
    match: { code: 'COMMAND_FAILED', foreignMessageIncludesAll: ['fetch failed'] },
    verdicts: { retryable: true, connectRetry: true },
  },
  {
    reason: 'econnrefused',
    // Node's net socket: "connect ECONNREFUSED <address>".
    match: { code: 'COMMAND_FAILED', foreignMessageIncludesAll: ['econnrefused'] },
    verdicts: { retryable: true, connectRetry: true },
  },
  {
    reason: 'socket_hang_up',
    // Node's http client: "socket hang up" when the peer closes before responding.
    match: { code: 'COMMAND_FAILED', foreignMessageIncludesAll: ['socket hang up'] },
    verdicts: { retryable: true, connectRetry: true },
  },
  {
    reason: 'ax_snapshot_failure',
    match: { code: 'IOS_AX_SNAPSHOT_FAILED' },
    verdicts: { sessionFatalReason: 'ax_snapshot_failure' },
  },
  {
    reason: 'xctest_recorded_failure',
    match: { code: 'XCTEST_RECORDED_FAILURE' },
    verdicts: { sessionFatalReason: 'xctest_recorded_failure' },
  },
  {
    // The runner reported its main thread stuck in abandoned work past the wedge
    // threshold (#1105): only a restart cures it. The per-request recycle budget
    // still bounds how many boots one request pays for.
    reason: 'runner_main_thread_wedged',
    match: { code: 'RUNNER_WEDGED' },
    verdicts: { sessionFatalReason: 'runner_main_thread_wedged' },
  },
  // ── Startup classification (#2680) ───────────────────────────────────────────────────────────
  // These rows answer "why could the runner not get here at all": `xcodebuild build-for-testing`
  // refusing, and the host preflight that runs before it. They carry a reason and a hint for the
  // caller and no recovery verdicts, because there is no session to invalidate and nothing was sent
  // to resend. Specific rows precede generic ones: the classifier takes the first match.
  //
  // Why these rows are text matchers while the rows above key on a code, a typed field, or a
  // foreign runtime's message:
  // `runnerToolText` reads xcodebuild's own prose because that prose is the only publication these
  // failures have — there is no code and no typed field to key on. Its haystack is deliberately
  // narrow: our message plus the tool's stdout/stderr, never the whole details bag, which also
  // holds the argv we were asked to run (so a caller's own PROVISIONING_PROFILE_SPECIFIER=… would
  // otherwise name a signing cause for an unrelated compile error) and the reason and hint this
  // classifier just published (so a re-wrapped failure would match itself). The DevToolsSecurity
  // row is the other half: where a probe of ours publishes a typed fact, the row keys on that fact
  // alone. `resolveRunnerEarlyExitHint` stays outside this table for the same reason it stays a hint
  // builder — it classifies a runner that DID build and then exited early, whose reason axis is the
  // `BootFailureReason` `classifyBootFailure` already returns, and a build that never produced a
  // binary has no boot to classify.
  {
    // A scoped set's simulator is reachable to xcodebuild only through `-DVTSimulatorSetLocation`, a
    // private Xcode user default; an Xcode that stops reading it finds no simulator with that id.
    reason: 'simulator_set_destination_not_found',
    match: {
      toolTextIncludesAll: ['matching the provided destination specifier'],
      details: hasSimulatorSetPath,
    },
    verdicts: {},
    buildFailure: {
      reason: 'simulator_set_destination_not_found',
      hint: 'Check that the simulator still exists in the --ios-simulator-device-set this error names (`xcrun simctl --set <set> list devices`). If it does, the Xcode this error names no longer honors -DVTSimulatorSetLocation, so use a simulator in the default set.',
    },
  },
  {
    reason: 'bundle_identifier_registration_failed',
    match: { toolTextIncludesAll: ['failed registering bundle identifier'] },
    verdicts: {},
    buildFailure: {
      reason: 'bundle_identifier_already_registered',
      hint: 'Set AGENT_DEVICE_IOS_BUNDLE_ID to a unique reverse-DNS value (for example, com.yourname.agentdevice.runner), then retry.',
    },
  },
  {
    // The identifier and its availability have to meet in one line: `App Identifier` and `not
    // available` are two phrases a captured log can carry for reasons that have nothing to do with
    // each other, which is the same hazard the profile rows just gave up (#2688 review).
    reason: 'bundle_identifier_unavailable',
    match: { toolTextLineIncludesAll: ['app identifier', 'not available'] },
    verdicts: {},
    buildFailure: {
      reason: 'bundle_identifier_already_registered',
      hint: 'Set AGENT_DEVICE_IOS_BUNDLE_ID to a unique reverse-DNS value (for example, com.yourname.agentdevice.runner), then retry.',
    },
  },
  {
    reason: 'signing_requires_development_team',
    match: { toolTextIncludesAll: ['requires a development team'] },
    verdicts: {},
    buildFailure: {
      reason: 'signing_no_development_team',
      hint: 'Configure signing in Xcode or set AGENT_DEVICE_IOS_TEAM_ID for physical-device runs.',
    },
  },
  {
    // "conflicting provisioning settings" names a profile while saying the automatic and manual
    // settings disagree, so without this row the profile row below would send the reader to install
    // a profile for a problem that is a settings mismatch. No reason is claimed for it: nothing has
    // captured this failure or proved which lever clears it, and advice the reader cannot follow is
    // worse than the cache-recovery advice the unclassified path already gives (#2680).
    reason: 'conflicting_provisioning_settings_unproven',
    match: { toolTextIncludesAll: ['conflicting provisioning settings'] },
    verdicts: {},
    buildFailure: {
      reason: RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON,
      hint: RUNNER_CACHE_RECOVERY_HINT,
    },
  },
  {
    // "No profiles for 'com.example' were found" names the bundle id and the absence in one sentence,
    // so the phrase alone is the complaint and needs no second phrase to qualify it.
    reason: 'signing_no_profiles_for_bundle_id',
    match: { toolTextIncludesAll: ['no profiles for'] },
    verdicts: {},
    buildFailure: PROFILE_UNUSABLE,
  },
  // A profile named in the tool's output is only evidence when the output also says what is wrong with
  // that profile, in the same line (#2688 review). One bare `provisioning profile` substring was the
  // shipped sniffer's trigger, and it is a phrase a failing build can print while talking about
  // something else: the codesign command line, a build-settings dump, a note about the profile that was
  // used. Requiring a second phrase somewhere in the same log is no better — a note about the profile
  // used above an unrelated `has expired` certificate warning would then name the profile. Each row
  // below therefore asks for the profile and Xcode's complaint about it on one line, and a failure that
  // merely mentions a profile stays unclassified rather than being sent to install one it already has.
  {
    // Xcode's own signing-error domain beside the profile it rejected: the machine-readable half of its
    // `IDEProvisioningErrorDomain` diagnostics, which accompanies the prose rather than replacing it.
    reason: 'signing_provisioning_profile_xcode_error',
    match: { toolTextLineIncludesAll: ['provisioning profile', 'ideprovisioningerrordomain'] },
    verdicts: {},
    buildFailure: PROFILE_UNUSABLE,
  },
  {
    // "Provisioning profile \"X\" doesn't include application identifier ..." — the profile that is
    // installed but does not cover this app or capability.
    reason: 'signing_provisioning_profile_does_not_cover',
    match: { toolTextLineIncludesAll: ['provisioning profile', "doesn't include"] },
    verdicts: {},
    buildFailure: PROFILE_UNUSABLE,
  },
  {
    // "Provisioning profile \"X\" has expired" — installing it again is not the fix; replacing it is,
    // which is what the hint's "valid" is for. The full phrase, on the profile's own line: `expired`
    // alone is what an expired certificate, a stale session, or a revoked key writes (#2688 review).
    reason: 'signing_provisioning_profile_expired',
    match: { toolTextLineIncludesAll: ['provisioning profile', 'has expired'] },
    verdicts: {},
    buildFailure: PROFILE_UNUSABLE,
  },
  {
    // Signing is involved but nothing above names how: the reason says signing and the hint stays
    // the generic one it has always carried, rather than naming a misconfiguration no rule proved.
    reason: 'signing_unspecified',
    match: { toolTextIncludesAll: ['code signing'] },
    verdicts: {},
    buildFailure: {
      reason: 'signing_unspecified',
      hint: 'Enable Automatic Signing in Xcode or provide AGENT_DEVICE_IOS_TEAM_ID and optional AGENT_DEVICE_IOS_SIGNING_IDENTITY.',
    },
  },
  {
    reason: 'devtools_security_refused',
    match: { code: 'COMMAND_FAILED', details: hasDevToolsSecurityStatus },
    verdicts: {},
    buildFailure: {
      reason: 'devtools_security_developer_mode_disabled',
      hint: 'Run `sudo DevToolsSecurity -enable`, then retry the iOS runner. UI test runners start suspended until Xcode/testmanagerd can attach.',
    },
  },
];

function matchesRunnerErrorRule(error: AppError, match: RunnerErrorMatch): boolean {
  if (match.code !== undefined && error.code !== match.code) return false;
  if (!matchesRunnerErrorDetails(error, match.details)) return false;
  if (!matchesRunnerToolText(error, match.toolTextIncludesAll)) return false;
  if (!matchesRunnerToolTextLine(error, match.toolTextLineIncludesAll)) return false;
  return matchesRunnerErrorMessage(error, match.foreignMessageIncludesAll);
}

function matchesRunnerErrorDetails(error: AppError, details: RunnerErrorMatch['details']): boolean {
  if (details === undefined) return true;
  return details((error.details ?? {}) as AppErrorDetails);
}

function matchesRunnerErrorMessage(error: AppError, parts: readonly string[] | undefined): boolean {
  if (!parts) return true;
  const message = `${error.message ?? ''}`.toLowerCase();
  return parts.every((part) => message.includes(part));
}

/**
 * The only text a startup rule may read: our message plus the tool's own `stdout` and `stderr`
 * (#2680). The rest of `details` is deliberately out of reach — `cmd`/`args` describe what we were
 * asked to run, and `reason`/`hint` are this classifier's own output, which a re-wrapped failure
 * would otherwise find and match again.
 */
function runnerToolText(error: AppError): string {
  const details = error.details ?? {};
  return [error.message, details.stdout, details.stderr]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();
}

function matchesRunnerToolText(error: AppError, parts: readonly string[] | undefined): boolean {
  if (!parts) return true;
  const text = runnerToolText(error);
  return parts.every((part) => text.includes(part));
}

/**
 * The same haystack read one line at a time, so a row can require its phrases to be in one sentence
 * rather than merely in one file (#2688 review). A captured build log is thousands of lines long, and
 * two unrelated lines can hold any pair of words.
 */
function matchesRunnerToolTextLine(error: AppError, parts: readonly string[] | undefined): boolean {
  if (!parts) return true;
  return runnerToolText(error)
    .split('\n')
    .some((line) => parts.every((part) => line.includes(part)));
}

function runnerErrorVerdict<Axis extends keyof RunnerErrorVerdicts>(
  error: unknown,
  axis: Axis,
): RunnerErrorVerdicts[Axis] | undefined {
  if (!(error instanceof AppError)) return undefined;
  for (const rule of RUNNER_ERROR_RULES) {
    if (rule.verdicts[axis] === undefined) continue;
    if (matchesRunnerErrorRule(error, rule.match)) return rule.verdicts[axis];
  }
  return undefined;
}

export function isRetryableRunnerError(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  if (err.code !== 'COMMAND_FAILED') return false;
  return runnerErrorVerdict(err, 'retryable') ?? false;
}

/**
 * True when the runner reported its main thread occupied by watchdog-abandoned XCTest work, either
 * as a fast refusal of this command (`RUNNER_BUSY`) or as the timeout the stalling command itself
 * returns (`MAIN_THREAD_TIMEOUT`) (#2552). Both are diagnostic-only on the wire (`COMMAND_FAILED` +
 * `details.runnerErrorCode`), so family policy reads the typed detail rather than the message.
 */
export function isRunnerMainThreadOccupiedError(error: unknown): boolean {
  if (isRunnerBusyError(error)) return true;
  return (
    error instanceof AppError && error.details?.runnerErrorCode === MAIN_THREAD_TIMEOUT_RUNNER_CODE
  );
}

/**
 * True when the runner refused this command outright because watchdog-abandoned XCTest work still
 * occupies its main thread (`RUNNER_BUSY`). Nothing was executed, so a read-only caller may resend
 * once the work drains; `MAIN_THREAD_TIMEOUT` is deliberately excluded because that command already
 * spent its wait.
 */
export function isRunnerBusyError(error: unknown): boolean {
  return runnerErrorVerdict(error, 'drainResend') ?? false;
}

/**
 * True when the runner answered with a structured failure: the reply itself carries the runner's
 * payload, so the command's outcome is known and no lifecycle status probe is needed to recover it.
 * A transport-shaped failure (aborted body, malformed payload, refused connection) answered nothing.
 */
export function isStructuredRunnerFailure(error: unknown): boolean {
  return error instanceof AppError && error.details?.runner !== undefined;
}

/**
 * True when usbmuxd answered and the device is simply not attached by cable.
 * A CoreDevice-backed device falls back to its network tunnel; an XCTest-backed
 * device has no second route, so this verdict is terminal rather than retryable.
 *
 * Lives here rather than beside the usbmux transport because the retry policy
 * below needs it, and that transport already depends on this module.
 */
export function isUsbmuxDeviceUnattachedError(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'DEVICE_NOT_FOUND') return false;
  return hasUsbmuxDeviceUnattached((error.details ?? {}) as AppErrorDetails);
}

/**
 * Default is true and not false: the common failure while the runner boots is an error
 * no rule describes, and giving up on it would fail a command that the connect loop was
 * about to succeed. A rule says false only when waiting cannot help.
 */
export function shouldRetryRunnerConnectError(error: unknown): boolean {
  return runnerErrorVerdict(error, 'connectRetry') ?? true;
}

/**
 * The readiness preflight gave up, so the runner never saw the command: restarting the session and
 * replaying is both safe and the only way out. The marker carries the rule; the message does not.
 */
export function shouldRestartRunnerAfterReadinessPreflight(error: unknown): boolean {
  return runnerErrorVerdict(error, 'restartAfterReadinessPreflight') ?? false;
}

/**
 * The runner refused or never answered on every route, which is what a restored artifact
 * that cannot boot looks like. Deliberately narrow: the recovery it authorises is a clean
 * `xcodebuild` rebuild, so a slow boot, a busy device or a transport failure partway
 * through a command must not pay that price.
 */
export function shouldRebuildCachedRunnerArtifact(error: unknown): boolean {
  return runnerErrorVerdict(error, 'artifactSuspect') ?? false;
}

/**
 * Session-fatal classification for a runner response error: when defined, the
 * cached runner session must be invalidated with this reason instead of being
 * reused (see ADR 0005 and docs/agents/selector-capture.md's
 * runnerFatal rule).
 */
export function resolveRunnerFatalErrorReason(error: unknown): string | undefined {
  return runnerErrorVerdict(error, 'sessionFatalReason');
}

/**
 * A connect-shaped failure that surfaced before the command was sent: restart
 * the runner session and replay the command, rather than probing a runner
 * that never accepted the connection.
 */
export function shouldRestartRunnerBeforeCommandSend(error: unknown): boolean {
  return runnerErrorVerdict(error, 'restartBeforeSend') ?? false;
}

/**
 * The one classifier for "the runner did not reach the point of serving a command" (#2680). Every
 * path that stops the runner before it answers a request routes its failure through here, so the
 * reason a caller sees is produced by the same rows that produce the hint beside it — a reason is
 * never inferred from a hint's wording, and an unproven cause is never claimed.
 *
 * Callers publish the pair as `details.reason` plus the top-level hint on a `COMMAND_FAILED`; the
 * code is `COMMAND_FAILED` for every reason, so the reason is the assertion.
 */
export function classifyRunnerStartupFailure(error: unknown): RunnerStartupClassification {
  if (error instanceof AppError) {
    for (const rule of RUNNER_ERROR_RULES) {
      const buildFailure = rule.buildFailure;
      if (!buildFailure) continue;
      if (matchesRunnerErrorRule(error, rule.match)) {
        return { reason: buildFailure.reason, hint: buildFailure.hint, matched: true };
      }
    }
  }
  return {
    reason: RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON,
    hint: RUNNER_CACHE_RECOVERY_HINT,
    matched: false,
  };
}

/**
 * The verdict, the advice beside it, and whether a row reached either (#2690 review). `matched` is
 * half the answer rather than an implementation detail: {@link RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON}
 * is also what a row that deliberately claims no cause publishes, so reading the reason alone cannot
 * tell "nothing spoke" from "a row spoke and declined to name a cause".
 */
export type RunnerStartupClassification = Readonly<{
  reason: RunnerStartupFailureReason;
  hint: string;
  /**
   * False only when no rule row matched at all. The catch that publishes this verdict carries it on
   * `details.startupRuleMatched`, which is the half a caller cannot recover from the reason alone.
   */
  matched: boolean;
}>;

/**
 * What the startup carries forward from the device so a later failure can say what the phone said
 * (#2683). The one thing that stops a run up front is a disabled Developer Mode toggle, which no
 * later step can change; everything else the device reports is only worth publishing beside the
 * failure it explains.
 */
export type IosRunnerDeviceStates = Readonly<{
  developerMode: IosDeveloperModeState;
  developerDiskImage: IosDeveloperDiskImageState;
  /** The remedy for an unavailable image, worded by `core/devicectl.ts` and read, not rewritten. */
  developerDiskImageHint: string;
}>;

/**
 * The device's turn on a startup failure (#2683, #2690 review), applied by the session's startup
 * catch so it reaches every path that stops a runner before it serves a command: a cold build, a warm
 * derived cache that fails at install, or an external xctestrun that never launches. The phone's own
 * state rides along as `details.developerDiskImage` on all of them, because it is a fact whoever is
 * reading this failure wants.
 *
 * It becomes the *reason* only when the failure carries no reason of its own and no rule row matched.
 * `devicectl` reports the image only while the tunnel is up and the phone is booted, so an
 * unavailable reading that reached here is a fact about the device rather than a snapshot of a sleeping
 * phone — but a failure that already named a cause, or that a row looked at and declined to name one
 * for, outranks a state that may have been cleared before the failure was written down. And a command
 * the host killed at its own deadline says nothing about the device either: the build that never
 * finished cannot have been refused for want of developer support, so a timeout outranks a state too.
 * An error that is not an `AppError` comes back untouched: a cancellation and a foreign failure keep
 * their identity.
 */
export function enrichRunnerStartupFailureWithDeviceStates(
  error: unknown,
  states: IosRunnerDeviceStates | undefined,
): unknown {
  if (!states || !(error instanceof AppError)) return error;
  const speaks =
    claimedStartupFailureReason(error) === undefined &&
    states.developerDiskImage === 'unavailable' &&
    !startupFailureRuleMatched(error) &&
    !startupFailureHostDeadlineHit(error);
  return new AppError(
    error.code,
    error.message,
    {
      ...(error.details ?? {}),
      ...(speaks
        ? {
            reason: 'device_developer_disk_image_unavailable',
            hint: states.developerDiskImageHint,
          }
        : {}),
      developerDiskImage: states.developerDiskImage,
    },
    error.cause,
  );
}

/**
 * The reason a startup failure already carries, discounting the placeholder the classifier publishes
 * when nothing proved a cause. Without this discount the build catch's own
 * `build_failed_unclassified` would read as a claimed cause and silence the device everywhere.
 */
function claimedStartupFailureReason(error: AppError): RunnerStartupFailureReason | undefined {
  const reason = error.details?.reason;
  if (typeof reason !== 'string' || reason === RUNNER_STARTUP_FAILURE_UNCLASSIFIED_REASON) {
    return undefined;
  }
  return reason as RunnerStartupFailureReason;
}

/**
 * Whether the host's own execution deadline ended the command behind this failure. A build the host
 * killed at `buildTimeoutMs` reaches the startup catch as `build_failed_unclassified` with nothing
 * matched, and an unavailable image sitting on the device would then be named as the cause of a build
 * that was simply too slow (#2690 review). A catch that published a classification carries the answer
 * in `details.startupHostDeadlineHit` for the same reason it carries `startupRuleMatched`: its wrapper
 * buries the tool error a level too deep to inspect. A failure that never passed through such a catch
 * is read here, where the exec's own `timeoutMs` detail is still in reach.
 */
function startupFailureHostDeadlineHit(error: AppError): boolean {
  const published = error.details?.startupHostDeadlineHit;
  if (typeof published === 'boolean') return published;
  return isCommandTimeoutError(error);
}

/**
 * Whether a rule row already reached this failure. A catch that published a classification carries its
 * own answer in `details.startupRuleMatched`, because its wrapper keeps the tool's text one level too
 * deep for the rows to read again — re-classifying the wrapper would report "nothing matched" for a
 * failure whose cause a row had just declined to name (#2690 review). A failure that never passed
 * through such a catch is classified here, which is the same answer its own publisher would have given.
 */
function startupFailureRuleMatched(error: AppError): boolean {
  const published = error.details?.startupRuleMatched;
  if (typeof published === 'boolean') return published;
  return classifyRunnerStartupFailure(error).matched;
}
