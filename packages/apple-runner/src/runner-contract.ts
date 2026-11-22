import {
  AppError,
  createRequestCanceledError,
  discloseDispatch,
  toAppErrorCode,
  type AppErrorCode,
  type DispatchDisclosure,
  type ReasonTable,
} from '@agent-device/kernel/errors';
import crypto from 'node:crypto';
import type {
  RunnerCommand,
  RunnerSequenceOrientation,
  RunnerSequenceStep,
} from './runner-command-types.ts';
import { getRequestSignal, isRequestCanceled } from './host.ts';

/**
 * The runner's own code for refusing a repeat of a `commandId` it already finished, when that
 * command's classification keeps no response body to replay. The command journal answers this; no
 * command ran for the repeat. It is therefore silent about the runner's main thread, and a caller
 * must not read it as drained occupancy ({@link runnerMainThreadOccupancyReport}).
 */
export const COMMAND_ALREADY_FINISHED_RUNNER_CODE: RunnerTableErrorCode =
  'COMMAND_ALREADY_FINISHED';

/** The longest readiness preflight a ready runner session pays before a conservative command. */
export const RUNNER_READY_PREFLIGHT_TIMEOUT_MS = 1_000;

/**
 * The runner's own code for a command it refused because abandoned main-thread work has occupied it
 * past the wedge threshold (#1105). Like `RUNNER_BUSY`, the refused command never ran.
 */
export const RUNNER_WEDGED_RUNNER_CODE: RunnerTableErrorCode = 'RUNNER_WEDGED';

export type {
  RunnerCommand,
  RunnerSequenceOrientation,
  RunnerSequenceStep,
  RunnerSnapshotBridgeRequest,
} from './runner-command-types.ts';

export function resolveRunnerRequestSignal(options: {
  requestId?: string;
  signal?: AbortSignal;
}): AbortSignal | undefined {
  const registeredSignal = getRequestSignal(options.requestId);
  if (!options.signal) return registeredSignal;
  if (!registeredSignal || registeredSignal === options.signal) return options.signal;
  return AbortSignal.any([registeredSignal, options.signal]);
}

type RunnerRequestSignalOptions = {
  requestId?: string;
  signal?: AbortSignal;
};

/**
 * Whether an abort reason is a caller's own deadline rather than a cancelled request. A `wait`
 * bounds each poll with an abort signal whose reason is a `TimeoutError` (`runWithinWaitDeadline`);
 * a cancelled request aborts through the registered request signal or the cancellation registry.
 * The typed reason decides, never the error text the transport threw on abort.
 */
export function isCallerDeadlineAbortReason(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'TimeoutError';
}

/**
 * Whether the caller's own deadline ended this command, as opposed to the request being cancelled.
 * A deadline that lands mid-fetch (surfacing as whatever the transport threw on abort) is read the
 * same way as one that wakes a delay.
 */
export function callerDeadlineExpired(options: RunnerRequestSignalOptions): boolean {
  if (isRequestCanceled(options.requestId) || getRequestSignal(options.requestId)?.aborted) {
    return false;
  }
  return options.signal?.aborted === true && isCallerDeadlineAbortReason(options.signal.reason);
}

/**
 * The signal a runner start reacts to. A cancelled request (client disconnect) must kill the
 * blocking xctestrun build and the runner launch instead of orphaning them, so the registered request
 * signal passes through untouched. A caller's own deadline must not: the runner start it interrupts
 * is the one the retry needs, and a start that pays itself again on every short-timeout poll never
 * finishes on a slow host (#2894). The start keeps going on its own startup budget, and the caller's
 * command is still cut off by its unfiltered signal once the runner answers.
 */
export function resolveRunnerStartupSignal(
  options: RunnerRequestSignalOptions,
): AbortSignal | undefined {
  const registeredSignal = getRequestSignal(options.requestId);
  const callerSignal = options.signal;
  if (!callerSignal || callerSignal === registeredSignal) return registeredSignal;
  // The caller signal is filtered through its own controller, so a deadline never reaches the
  // start; the registered signal is composed with `AbortSignal.any`, which detaches its own
  // listener once the composed signal settles, so a request that polls many times does not
  // accumulate listeners on its long-lived cancellation signal.
  const filtered = new AbortController();
  const forward = () => {
    if (!isCallerDeadlineAbortReason(callerSignal.reason)) filtered.abort(callerSignal.reason);
  };
  if (callerSignal.aborted) forward();
  else callerSignal.addEventListener('abort', forward, { once: true });
  return registeredSignal ? AbortSignal.any([registeredSignal, filtered.signal]) : filtered.signal;
}

/**
 * The code the XCTest runner answers with when it declines to place a scroll gesture under the
 * on-screen keyboard (#2500). It is the runner's own vocabulary, so it is declared here beside the
 * table row that keeps it off the wire, and the Apple scroll owner matches it on
 * `details.runnerErrorCode` rather than on error text.
 */
export const SCROLL_KEYBOARD_OCCLUDES_SURFACE_RUNNER_CODE: RunnerTableErrorCode =
  'SCROLL_KEYBOARD_OCCLUDES_SURFACE';

/**
 * The runner codes for a synthesized long press, scroll, or planned gesture on iOS; the CLI `swipe` is
 * a planned fling gesture. Both are rows of {@link RUNNER_ERROR_CODES}.
 * NOT_DISPATCHED: the event synthesis refused before any of its events reached XCTest, so the
 * command sent nothing. OUTCOME_UNKNOWN: failed after its events reached XCTest, so it may have run;
 * the runner never falls back to repeat it. Any other refusal, a platform one included, keeps
 * UNSUPPORTED_OPERATION.
 */
const SYNTHESIZED_GESTURE_OUTCOME_UNKNOWN_RUNNER_CODE: RunnerTableErrorCode =
  'SYNTHESIZED_GESTURE_OUTCOME_UNKNOWN';

/**
 * The runner codes for an iOS `back` swipe, rows of {@link RUNNER_ERROR_CODES}. BACK_SWIPE_NO_CHANGE:
 * the swipe was sent and the screen did not change. BACK_SWIPE_UNVERIFIED: the swipe was sent but
 * the screen kept changing before it or could not be sampled after it. Both ran the swipe, so they
 * stay `unknown`. BACK_SWIPE_NOT_DISPATCHED: the swipe was refused before any touch went down.
 */
const BACK_SWIPE_NO_CHANGE_RUNNER_CODE: RunnerTableErrorCode = 'BACK_SWIPE_NO_CHANGE';

/**
 * One row per runner error code: the single declaration of what the host does with a reported
 * code, replacing the four parallel maps this file used to keep. A new runner refusal is one row
 * here: `pnpm generate:runner-error-codes` writes the Swift `RunnerWireErrorCode` enum from the
 * keys, and the `runner-error-codes` gate fails while the generated file is stale. A row holds:
 * - `dispatched`: what the reply proves about reaching the device — refusals answer before the
 *   command runs (selector refusals included; `INVALID_ARGS` comes only from request decoding,
 *   ahead of any gesture); every other code, and a reply without one, is `unknown`.
 * - `reason`: the `details.reason` a consumer acts on instead of `details.runnerErrorCode`; the
 *   union below is derived from the rows.
 * - `diagnosticOnly`: the code classifies a failure without renaming it on the wire — it stays
 *   `COMMAND_FAILED` unless `wireCode` names the family code the caller already reads (the
 *   keyboard and hardware refusals stay `UNSUPPORTED_OPERATION`) — and survives as
 *   `details.runnerErrorCode`, which family policy reads (`RUNNER_BUSY` retriable contention,
 *   `ALERT_NOT_FOUND`, the scroll keyboard refusal, retriable `APP_NOT_RUNNING`).
 */
export type RunnerErrorCodeRow = Readonly<{
  dispatched: DispatchDisclosure;
  reason?: string;
  diagnosticOnly?: Readonly<{
    retriable?: boolean;
    wireCode?: AppErrorCode;
  }>;
}>;

/**
 * The `details.reason` values the host publishes for Apple runner failures: the reasons the rows of
 * {@link RUNNER_ERROR_CODES} map runner codes to (the runner itself writes no reason), and the
 * refusals this module raises before or around a runner exchange.
 */
export const RUNNER_ERROR_REASONS = {
  // The runner was still busy with an earlier command and refused this one; retry it.
  runnerBusy: { reason: 'runner_busy' },
  // The command's work on the app's main thread did not finish in time, so it may have run.
  mainThreadTimeout: { reason: 'runner_main_thread_timeout' },
  // A coordinate `fill` point identified no text input, so nothing was tapped or typed.
  noTextInputAtPoint: { reason: 'no_text_input_at_point', commands: ['fill'] },
  // The runner could not tell whether a coordinate `fill` point holds a text input; nothing was tapped.
  textInputProbeUnavailable: { reason: 'text_input_probe_unavailable', commands: ['fill'] },
  // The runner refused the gesture before its events reached XCTest, so nothing was sent.
  synthesizedGestureNotDispatched: { reason: 'synthesized_gesture_not_dispatched' },
  // The gesture failed after its events reached XCTest, so it may have run.
  synthesizedGestureOutcomeUnknown: { reason: 'synthesized_gesture_outcome_unknown' },
  // The back swipe ran and left the app's screen unchanged.
  backSwipeNoChange: { reason: 'back_swipe_no_change', commands: ['back'] },
  // The back swipe ran, but the screen was already changing or could not be sampled afterwards.
  backSwipeUnverified: { reason: 'back_swipe_unverified', commands: ['back'] },
  // The back swipe was refused before it reached the device.
  backSwipeNotDispatched: { reason: 'back_swipe_not_dispatched', commands: ['back'] },
  // A Return on the focused input could not be confirmed; a tap on the field may have landed.
  keyboardReturnUnavailable: { reason: 'keyboard_return_unavailable' },
  // The target has no such hardware control, such as an Action Button, so nothing was pressed.
  hardwareControlUnavailable: { reason: 'hardware_control_unavailable' },
  // On macOS, the app's accessibility tree exposes no in-app back control.
  inAppBackControlUnavailable: { reason: 'in_app_back_control_unavailable', commands: ['back'] },
  // Apple's audit failed while a system alert covered the app; answer the alert, then retry.
  nativeAuditBlockedByAlert: { reason: 'native_audit_blocked_by_alert', commands: ['audit'] },
  // The runner build does not require a listener token; rebuild it with this agent-device version.
  tokenUnsupported: { reason: 'runner_token_unsupported' },
  // The daemon refused a runner action sequence before sending it, so nothing reached the device.
  sequenceInvalid: { reason: 'runner_sequence_invalid' },
  // Another request took over the Apple runner session before this command was sent.
  sessionOwnershipChanged: { reason: 'runner_session_ownership_changed' },
} as const satisfies ReasonTable<'apple runner'>;

export const RUNNER_ERROR_CODES = {
  INVALID_ARGS: { dispatched: 'no' },
  ELEMENT_NOT_FOUND: { dispatched: 'no' },
  ELEMENT_OFFSCREEN: { dispatched: 'no' },
  AMBIGUOUS_MATCH: { dispatched: 'no' },
  OBSERVATION_UNAVAILABLE: { dispatched: 'no' },
  // Transient by construction (#1105) — past the wedge threshold the runner escalates to
  // RUNNER_WEDGED — so every host path publishes this refusal as retriable.
  RUNNER_BUSY: {
    dispatched: 'no',
    reason: RUNNER_ERROR_REASONS.runnerBusy.reason,
    diagnosticOnly: { retriable: true },
  },
  RUNNER_WEDGED: { dispatched: 'no' },
  // A repeat of a `commandId` the runner already finished, when that command keeps no response body
  // to replay. Nothing ran for the repeat, but only the runner knows whether an earlier send of that
  // id reached the device, so the disclosure stays `unknown`.
  COMMAND_ALREADY_FINISHED: { dispatched: 'unknown' },
  // A read whose session app is not running: no runner read launches the app (a bare launch would
  // drop a pending launch's payload), so the runner refuses the read-only command. The refusal
  // describes one poll, so it is retriable for a `wait` while the transport never resends it.
  APP_NOT_RUNNING: { dispatched: 'no', diagnosticOnly: { retriable: true } },
  MAIN_THREAD_TIMEOUT: {
    // This is the answer the stalling command itself gives: its main-thread work was abandoned and the
    // thread is now occupied (#2552), so the command may have run. Unlike RUNNER_BUSY, the fast refusal
    // of a later command, this is the only typed signal available before any refusal happens. It is not
    // retriable: the wait already elapsed and an immediate retry would only meet RUNNER_BUSY.
    dispatched: 'unknown',
    reason: RUNNER_ERROR_REASONS.mainThreadTimeout.reason,
    diagnosticOnly: {},
  },
  SCROLL_KEYBOARD_OCCLUDES_SURFACE: { dispatched: 'no', diagnosticOnly: {} },
  ALERT_NOT_FOUND: { dispatched: 'no', diagnosticOnly: {} },
  // The XCUITest runner refused an `accept` or `dismiss` because no button on the alert fits the
  // action: `dismiss` found no label on its decline list, and tapping anything else could answer an
  // affirmative (#3627). The refusal is made in the button choice, before any activation.
  ALERT_BUTTON_NOT_FOUND: { dispatched: 'no' },
  // Required alert acquisition failed or exhausted its deadline. It establishes no absence and
  // activates nothing.
  ALERT_UNRESOLVED: { dispatched: 'no' },
  // A coordinate `fill` whose point identified no text input (#1721). The synthesized first-responder
  // replacement this route would otherwise take has no element, so its clear and its typed text reach
  // whichever field already holds focus. The refusal answers before the focus tap.
  NO_TEXT_INPUT_AT_POINT: {
    dispatched: 'no',
    reason: RUNNER_ERROR_REASONS.noTextInputAtPoint.reason,
  },
  // A coordinate `fill` whose pre-tap input lookup could not answer on the degraded channel. Like
  // NO_TEXT_INPUT_AT_POINT it answers before the focus tap, and it is not a claim that the point has
  // no input — only that the runner could not tell.
  TEXT_INPUT_PROBE_UNAVAILABLE: {
    dispatched: 'no',
    reason: RUNNER_ERROR_REASONS.textInputProbeUnavailable.reason,
  },
  // Refused before the gesture's events reached XCTest, so the command sent nothing.
  SYNTHESIZED_GESTURE_NOT_DISPATCHED: {
    dispatched: 'no',
    reason: RUNNER_ERROR_REASONS.synthesizedGestureNotDispatched.reason,
    diagnosticOnly: {},
  },
  // Failed after the gesture's events reached XCTest, so it may have run.
  SYNTHESIZED_GESTURE_OUTCOME_UNKNOWN: {
    dispatched: 'unknown',
    reason: RUNNER_ERROR_REASONS.synthesizedGestureOutcomeUnknown.reason,
    diagnosticOnly: {},
  },
  // The swipe ran and left the app's screen unchanged.
  BACK_SWIPE_NO_CHANGE: {
    dispatched: 'unknown',
    reason: RUNNER_ERROR_REASONS.backSwipeNoChange.reason,
    diagnosticOnly: {},
  },
  // The swipe ran, but the screen kept changing on its own beforehand or could not be sampled after.
  BACK_SWIPE_UNVERIFIED: {
    dispatched: 'unknown',
    reason: RUNNER_ERROR_REASONS.backSwipeUnverified.reason,
    diagnosticOnly: {},
  },
  BACK_SWIPE_NOT_DISPATCHED: {
    dispatched: 'no',
    reason: RUNNER_ERROR_REASONS.backSwipeNotDispatched.reason,
    diagnosticOnly: {},
  },
  // The Apple runner left the visible keyboard alone: it exposes no dismiss key, and a background tap
  // is never attempted, so the refusal proves nothing was pressed.
  KEYBOARD_DISMISS_UNAVAILABLE: {
    dispatched: 'no',
    reason: 'keyboard_dismiss_unavailable',
    diagnosticOnly: { wireCode: 'UNSUPPORTED_OPERATION' },
  },
  // A Return attempt on the focused input could not be confirmed. The row keeps `unknown`: the
  // sole-text-field route taps the field before typing the return, so a refusal can follow a tap that
  // landed.
  KEYBOARD_RETURN_UNAVAILABLE: {
    dispatched: 'unknown',
    reason: RUNNER_ERROR_REASONS.keyboardReturnUnavailable.reason,
    diagnosticOnly: { wireCode: 'UNSUPPORTED_OPERATION' },
  },
  // A press of a hardware or Siri Remote control this target cannot perform. Today that is the Action
  // Button on an iPhone or iPad model without one: the daemon admits `action-button` for every iPhone
  // and iPad and lets the runner answer whether the hardware is there. A volume key on a simulator and
  // a remote button off tvOS are refused by runtime admission before the runner is reached, so those
  // refusals carry `unsupported-device-kind` and `unsupported-platform-leaf`. The press helper answers
  // false before pressing anything, so the reply proves nothing was sent. One code covers the family
  // because the recovery is one question — does this target have that control — and the message names
  // the control.
  HARDWARE_CONTROL_UNAVAILABLE: {
    dispatched: 'no',
    reason: RUNNER_ERROR_REASONS.hardwareControlUnavailable.reason,
    diagnosticOnly: { wireCode: 'UNSUPPORTED_OPERATION' },
  },
  // macOS `back` where the app's tree exposes no in-app back control. That refusal answered with no
  // code at all before, which left the caller reading prose, and the host read the reply as
  // `COMMAND_FAILED`. There is no wire-code override on purpose: the `UNSUPPORTED_OPERATION` family is
  // the wrong home for it and this row must not move the command to a code its callers never saw.
  IN_APP_BACK_CONTROL_UNAVAILABLE: {
    dispatched: 'no',
    reason: RUNNER_ERROR_REASONS.inAppBackControlUnavailable.reason,
    diagnosticOnly: {},
  },
  // `audit` asked a runner that cannot run Apple's audit for it: an OS older than iOS 17, or a
  // platform other than iOS. The host reads the code and answers with the heuristic findings alone,
  // so the row publishes no reason. It keeps `unknown`, the disclosure it had before the table.
  NATIVE_AUDIT_UNAVAILABLE: {
    dispatched: 'unknown',
    diagnosticOnly: { wireCode: 'UNSUPPORTED_OPERATION' },
  },
  // Apple's audit failed while a system alert covered the app. The runner names the alert and its
  // hint tells the caller to answer it. The audit types the runner requests change nothing in the
  // app, so the reply proves no effect reached it.
  NATIVE_AUDIT_BLOCKED_BY_ALERT: {
    dispatched: 'no',
    reason: RUNNER_ERROR_REASONS.nativeAuditBlockedByAlert.reason,
    diagnosticOnly: {},
  },
  // The four runner codes meaning "this capture did not happen" (#2728), covering the display, the
  // image, and the panel. The runner emits them from every consumer of its one screen-capture helper —
  // the `screenshot` command's fallback, `record start`'s required first frame, and an optional visual
  // check such as the `back` fallback's before/after sample. A required capture fails closed on them
  // rather than falling back to a screen nobody is on, and an optional one reports the refusal as an
  // unknown. Only the `screenshot` route reads the family for its own simctl-to-runner decision.
  // No window resolved, so no display could be named.
  APP_SCREEN_WINDOW_UNRESOLVED: { dispatched: 'no', diagnosticOnly: {} },
  // The resolved window named no display.
  APP_SCREEN_UNRESOLVED: { dispatched: 'no', diagnosticOnly: {} },
  // The resolved display handed back an image it could not encode upright.
  APP_SCREEN_CAPTURE_UNRENDERABLE: { dispatched: 'no', diagnosticOnly: {} },
  // On a foldable, every window of the target app is on the dark panel.
  APP_SCREEN_OFF_LIT_PANEL: { dispatched: 'no', diagnosticOnly: {} },
} as const satisfies Record<string, RunnerErrorCodeRow>;

/**
 * A code with a row in {@link RUNNER_ERROR_CODES}. The code constants are typed with it, so a
 * constant naming no row fails to compile. Runner codes the host passes through unclassified get
 * no row here; {@link RUNNER_PASS_THROUGH_CODES} declares them.
 */
export type RunnerTableErrorCode = keyof typeof RUNNER_ERROR_CODES;

/**
 * The runner codes the host does not classify: they get no row of {@link RUNNER_ERROR_CODES}, so
 * {@link classifyRunnerReportedError} hands each one to `toAppErrorCode`, which publishes it
 * verbatim as the command's own `AppError.code`. No host policy reads them: no reason, no
 * retriable flag, no dispatch disclosure beyond the generic one. The list exists so that
 * `pnpm generate:runner-error-codes` can write the Swift `RunnerPassThroughErrorCode` enum the
 * emitters use. A code the host learns to branch on moves to a table row.
 */
export const RUNNER_PASS_THROUGH_CODES = [
  'TEXT_ENTRY_MISMATCH', // `fill` read-back found different text than it typed
  'TEXT_INPUT_NOT_FOCUSED',
  'TEXT_INPUT_SYNTHESIS_UNAVAILABLE',
  'TEXT_INPUT_COMMIT_NOT_OBSERVED',
  'TEXT_INPUT_CLEAR_NOT_OBSERVED',
  'TEXT_INPUT_SYNTHESIS_BUDGET_EXCEEDED',
  'XCTEST_RECORDED_FAILURE', // the failure was recorded by XCTest itself
  'ALERT_DEADLINE_EXCEEDED',
  'ALERT_CONFIRMATION_UNAVAILABLE',
  'IOS_TREE_CAPTURE_TIMEOUT',
  'IOS_AX_SNAPSHOT_FAILED',
  'IOS_RAW_SNAPSHOT_TOO_LARGE',
  'IOS_SNAPSHOT_TOO_LARGE',
  'IOS_SNAPSHOT_PROJECTION_MISMATCH',
  'IOS_SNAPSHOT_PRESENTATION_FAILED',
] as const;

/**
 * `details.reason` for the runner codes a consumer acts on, derived from {@link RUNNER_ERROR_CODES}
 * so the published union cannot drift from the rows that publish it.
 */
export type RunnerReportedErrorReason = {
  [Code in keyof typeof RUNNER_ERROR_CODES]: (typeof RUNNER_ERROR_CODES)[Code] extends {
    reason: infer Reason;
  }
    ? Reason
    : never;
}[keyof typeof RUNNER_ERROR_CODES];

/** A row of {@link RUNNER_ERROR_CODES} as a reader sees it, with the reason union applied. */
export type RunnerErrorCodeRowView = Readonly<{
  dispatched: DispatchDisclosure;
  reason?: RunnerReportedErrorReason;
  diagnosticOnly?: Readonly<{ retriable?: boolean; wireCode?: AppErrorCode }>;
}>;

/** The one row for a runner-reported code, or undefined for a code the table does not declare. */
function runnerErrorCodeRow(
  runnerErrorCode: string | undefined,
): RunnerErrorCodeRowView | undefined {
  if (runnerErrorCode === undefined || !Object.hasOwn(RUNNER_ERROR_CODES, runnerErrorCode)) {
    return undefined;
  }
  return RUNNER_ERROR_CODES[runnerErrorCode as keyof typeof RUNNER_ERROR_CODES];
}

/** Wire code plus the details every path must publish for one runner-reported error code. */
export type RunnerReportedErrorClass = Readonly<{
  code: AppError['code'];
  details: Readonly<{
    runnerErrorCode?: string;
    retriable?: true;
    reason?: RunnerReportedErrorReason;
    dispatched: DispatchDisclosure;
  }>;
}>;

/** Classifies live and retained runner failures from the original protocol code. */
export function classifyRunnerReportedError(
  runnerErrorCode: string | undefined,
  scrubText?: (text: string) => string,
): RunnerReportedErrorClass {
  const row = runnerErrorCodeRow(runnerErrorCode);
  // A code the table does not declare carries no dispatch evidence, so it publishes `unknown`.
  const dispatched = row?.dispatched ?? 'unknown';
  return Object.freeze({
    code:
      row?.diagnosticOnly !== undefined
        ? (row.diagnosticOnly.wireCode ?? 'COMMAND_FAILED')
        : toAppErrorCode(runnerErrorCode),
    details: Object.freeze({
      runnerErrorCode:
        row || runnerErrorCode === undefined
          ? runnerErrorCode
          : (scrubText?.(runnerErrorCode) ?? runnerErrorCode),
      ...(row?.diagnosticOnly?.retriable === true ? { retriable: true as const } : {}),
      ...(row?.reason === undefined ? {} : { reason: row.reason }),
      dispatched,
    }),
  });
}

export type RunnerResponsePayload = {
  ok?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    hint?: unknown;
    dismissControls?: unknown;
  };
  data?: unknown;
};

/**
 * One entry of `details.dismissControls`: a control the caller may press to leave the screen an iOS
 * `back` could not, such as a full-screen modal's Close button. `selector` presses it without a new
 * snapshot. It is a selector, not a ref: back is a mutation, so it expires the session's ref frame
 * before it swipes (ADR 0014), and the runner reads no snapshot tree to mint refs from.
 */
export type BackDismissControl = Readonly<{ selector: string; label: string; identifier?: string }>;

/**
 * The dismiss controls the runner names on a `BACK_SWIPE_NO_CHANGE` refusal, each with its selector.
 * The runner's `pressBy` names the attribute no other button shares. Both forms carry `role=button`,
 * which scopes the match to the buttons the runner checked, and resolves through the snapshot tree:
 * `identifier` becomes `role=button id="…"`, and `label` becomes `role=button label="…"`. Other codes, and entries that are not
 * `{ label, identifier?, pressBy }` objects, publish nothing.
 */
function readBackDismissControls(
  runnerErrorCode: string | undefined,
  error: RunnerResponsePayload['error'],
): BackDismissControl[] {
  if (runnerErrorCode !== BACK_SWIPE_NO_CHANGE_RUNNER_CODE) return [];
  const entries = error?.dismissControls;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown): BackDismissControl[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { label, identifier, pressBy } = entry as {
      label?: unknown;
      identifier?: unknown;
      pressBy?: unknown;
    };
    if (typeof label !== 'string') return [];
    const id = typeof identifier === 'string' && identifier.length > 0 ? identifier : undefined;
    const selector =
      pressBy === 'identifier' && id !== undefined
        ? `role=button id=${JSON.stringify(id)}`
        : pressBy === 'label' && label.length > 0
          ? `role=button label=${JSON.stringify(label)}`
          : undefined;
    if (selector === undefined) return [];
    return [{ selector, label, ...(id === undefined ? {} : { identifier: id }) }];
  });
}

/** The refusal hint once dismiss controls are known; the runner's own hint otherwise. */
function backDismissHint(controls: readonly BackDismissControl[]): string | undefined {
  const [only] = controls;
  if (only === undefined) return undefined;
  return controls.length === 1
    ? `Press '${only.selector}' to dismiss this screen; back only pops the navigation stack.`
    : 'Press one of details.dismissControls by its selector to dismiss this screen; back only pops the navigation stack.';
}

/** Decodes command, retained journal, and adoption replies with the same envelope rules. */
export function decodeRunnerResponseBody(
  text: string,
  scrubText?: (text: string) => string,
): RunnerResponsePayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isRunnerEnvelopeObject(parsed)) {
    throw new AppError('COMMAND_FAILED', 'Invalid runner response', {
      text: scrubText?.(text) ?? text,
    });
  }
  return parsed;
}

function isRunnerEnvelopeObject(parsed: unknown): parsed is RunnerResponsePayload {
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/** The runner's `ok` is a Swift `Bool`, so only the literal `true` is an answer. */
export function isRunnerResponseOk(payload: RunnerResponsePayload): boolean {
  return payload.ok === true;
}

export function readRunnerResponseData(payload: RunnerResponsePayload): Record<string, unknown> {
  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) return {};
  return payload.data as Record<string, unknown>;
}

export function buildRunnerResponseError(
  payload: RunnerResponsePayload,
  logPath?: string,
  diagnostics?: NonNullable<RunnerEndpoint['http']>['diagnostics'],
): AppError {
  const rawCode = payload.error?.code;
  const runnerErrorCode = typeof rawCode === 'string' ? rawCode.trim() || undefined : undefined;
  const text = diagnostics?.scrubText ?? ((value) => value);
  const errorMessage =
    typeof payload.error?.message === 'string' ? text(payload.error.message) : undefined;
  const hint = typeof payload.error?.hint === 'string' ? text(payload.error.hint) : undefined;
  const classification = classifyRunnerReportedError(runnerErrorCode, text);
  const dismissControls = readBackDismissControls(runnerErrorCode, payload.error).filter(
    (control) => !diagnostics || diagnostics.scrubPayload(control) === control,
  );
  return new AppError(classification.code, errorMessage ?? 'Runner error', {
    runner: diagnostics ? diagnostics.scrubPayload(payload) : payload,
    ...classification.details,
    ...(dismissControls.length > 0 ? { dismissControls } : {}),
    xcodebuild: {
      exitCode: 1,
      stdout: '',
      stderr: '',
    },
    hint: backDismissHint(dismissControls) ?? hint,
    logPath,
  });
}

export function withRunnerCommandId(command: RunnerCommand): RunnerCommand {
  if (command.command === 'status') return command;
  if (command.commandId?.trim()) return command;
  return { ...command, commandId: createRunnerCommandId() };
}

function createRunnerCommandId(): string {
  return `runner-${crypto.randomUUID()}`;
}

export function assertRunnerRequestActive(requestId: string | undefined): void {
  if (!isRequestCanceled(requestId)) return;
  throw createRequestCanceledError();
}

const RUNNER_TOKEN_HEADER = 'X-Agent-Device-Runner-Token';
const RUNNER_TOKEN_ENFORCED_HEADER = 'X-Agent-Device-Runner-Auth';
const RUNNER_TOKEN_BYTES = 24;

/** How to reach one runner generation: its listener port and the token it requires. */
export type RunnerEndpoint = Readonly<{
  port: number;
  token: string;
  /** A provider's authenticated forwarding route; omitted for local and USB runners. */
  http?: Readonly<{
    url: string;
    headers?: Readonly<Record<string, string>>;
    diagnostics?: Readonly<{
      scrubText(text: string): string;
      scrubPayload(payload: unknown): unknown;
    }>;
  }>;
}>;

export function mintRunnerToken(): string {
  return crypto.randomBytes(RUNNER_TOKEN_BYTES).toString('base64url');
}

/** What the runner reads at launch to open its listener; see `RunnerTests+Environment.swift`. */
export function runnerListenerEnv(
  endpoint: RunnerEndpoint,
  bindAddress?: string,
): Record<string, string> {
  return {
    AGENT_DEVICE_RUNNER_PORT: String(endpoint.port),
    AGENT_DEVICE_RUNNER_TOKEN: endpoint.token,
    ...(bindAddress ? { AGENT_DEVICE_RUNNER_BIND_IP: bindAddress } : {}),
  };
}

export function runnerRequestHeaders(endpoint: RunnerEndpoint): Record<string, string> {
  return { 'Content-Type': 'application/json', [RUNNER_TOKEN_HEADER]: endpoint.token };
}

/**
 * Passes a reply only from a runner that declares it requires the token. A runner built before the
 * token existed listens without one, so it is refused rather than driven.
 */
export function requireTokenEnforcingRunner(response: Response): Response {
  if (response.headers.get(RUNNER_TOKEN_ENFORCED_HEADER) === 'required') return response;
  throw new AppError('COMMAND_FAILED', 'XCTest runner does not require a listener token', {
    reason: RUNNER_ERROR_REASONS.tokenUnsupported.reason,
    hint: 'Rebuild the runner with this agent-device version. A configured iosXctestrunFile must come from the same version.',
  });
}

export const SEQUENCEABLE_RUNNER_STEP_KINDS = ['tap', 'doubleTap', 'longPress'] as const;
export type SequenceableRunnerStepKind = (typeof SEQUENCEABLE_RUNNER_STEP_KINDS)[number];

/**
 * Hard cap on steps per `sequence` request. Two constraints set this bound:
 * - The retained journal response stays well under the 16KB cap: 20 steps x ~150B
 *   per-step result (~3-4KB worst case) leaves ample headroom for lost-response recovery.
 * - It bounds the UI-uncertainty window when a transport response is lost mid-sequence —
 *   at most 20 ordered mutating steps can have run unobserved.
 * Longer daemon-side series chunk into ceil(N/20) requests (still stop-on-failure across chunks).
 */
export const MAX_RUNNER_SEQUENCE_STEPS = 20;

// The runner clamps durationMs to 16..10000 (RunnerTests+SequenceExecution.swift), so the
// validator only guards the upper bound and finiteness; the floor is the runner's job. This keeps
// legal CLI input like `press --hold-ms 5` (holdMs min 0) acceptable instead of rejecting it here.
const MIN_DURATION_MS = 0;
const MAX_DURATION_MS = 10_000;
const MIN_PAUSE_MS = 0;
const MAX_PAUSE_MS = 10_000;

export type RunnerSequenceStepResult = {
  ok: boolean;
  kind: string;
  errorCode?: string;
  errorMessage?: string;
  errorHint?: string;
  gestureStartUptimeMs?: number;
  gestureEndUptimeMs?: number;
};

export type ParsedRunnerSequenceResult = {
  results: RunnerSequenceStepResult[];
  completedSteps: number;
  failedStepIndex?: number;
  sequenceOrientation?: RunnerSequenceOrientation;
};

function isSequenceableKind(kind: unknown): kind is SequenceableRunnerStepKind {
  return (
    typeof kind === 'string' && (SEQUENCEABLE_RUNNER_STEP_KINDS as readonly string[]).includes(kind)
  );
}

/** A sequence the daemon refuses before sending it: nothing reached the runner. */
function invalidSequence(message: string, details: Record<string, unknown>): AppError {
  return discloseDispatch(
    new AppError('INVALID_ARGS', message, {
      ...details,
      reason: RUNNER_ERROR_REASONS.sequenceInvalid.reason,
    }),
    'no',
  );
}

function invalidStep(index: number, kind: unknown, message: string): AppError {
  return invalidSequence(message, {
    stepIndex: index,
    kind: typeof kind === 'string' ? kind : undefined,
  });
}

/**
 * Validates an ordered list of sequence steps before sending, throwing AppError('INVALID_ARGS')
 * naming the offending step index and kind. The runner rejects the same kinds, missing coords, and
 * over-length lists with nothing executed; durations differ — the runner clamps durationMs into
 * 16..10000 rather than rejecting, so this validator only rejects non-finite/negative/too-high
 * durations and leaves the floor to the runner's clamp.
 */
export function validateRunnerSequenceSteps(steps: RunnerSequenceStep[]): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw invalidSequence('sequence requires at least one step', {
      stepCount: Array.isArray(steps) ? steps.length : 0,
    });
  }
  if (steps.length > MAX_RUNNER_SEQUENCE_STEPS) {
    throw invalidSequence(
      `sequence accepts at most ${MAX_RUNNER_SEQUENCE_STEPS} steps, received ${steps.length}`,
      { stepCount: steps.length, maxSteps: MAX_RUNNER_SEQUENCE_STEPS },
    );
  }
  steps.forEach((step, index) => validateRunnerSequenceStep(step, index));
}

function validateRunnerSequenceStep(step: RunnerSequenceStep, index: number): void {
  if (!isSequenceableKind(step.kind)) {
    throw invalidStep(
      index,
      step.kind,
      `sequence step ${index} has unsupported kind "${String(step.kind)}"; allowed: ${SEQUENCEABLE_RUNNER_STEP_KINDS.join(', ')}`,
    );
  }
  if (!Number.isFinite(step.x) || !Number.isFinite(step.y)) {
    throw invalidStep(
      index,
      step.kind,
      `sequence step ${index} (${step.kind}) requires finite x and y`,
    );
  }
  if (step.durationMs !== undefined) {
    assertInRange(
      step.durationMs,
      MIN_DURATION_MS,
      MAX_DURATION_MS,
      index,
      step.kind,
      'durationMs',
    );
  }
  if (step.pauseMs !== undefined) {
    assertInRange(step.pauseMs, MIN_PAUSE_MS, MAX_PAUSE_MS, index, step.kind, 'pauseMs');
  }
}

function assertInRange(
  value: number,
  min: number,
  max: number,
  index: number,
  kind: string,
  field: string,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw invalidStep(
      index,
      kind,
      `sequence step ${index} (${kind}) ${field} must be between ${min} and ${max}`,
    );
  }
}

export function buildRunnerSequenceCommand(
  steps: RunnerSequenceStep[],
  appBundleId?: string,
): RunnerCommand {
  validateRunnerSequenceSteps(steps);
  return { command: 'sequence', steps, appBundleId };
}

/**
 * Single interpretation point for a `sequence` runner response. The runner returns
 * ok:true even when a step failed (step failure is data, so the tracked unit completed
 * and its results are retained for lost-response recovery). This maps a present
 * failedStepIndex into a deterministic AppError keyed off the failing step's errorCode,
 * naming the step index and kind, with completedSteps + per-step results in details.
 *
 * Any future caller issuing `sequence` MUST route the response through here, or step
 * failures will be silently ignored.
 */
export function parseRunnerSequenceResult(
  data: Record<string, unknown>,
): ParsedRunnerSequenceResult {
  const results = readSequenceResults(data.sequenceResults);
  const completedSteps =
    typeof data.completedSteps === 'number' && Number.isFinite(data.completedSteps)
      ? data.completedSteps
      : results.filter((result) => result.ok).length;
  const detectedFailedStepIndex = results.findIndex((result) => !result.ok);
  const failedStepIndex =
    typeof data.failedStepIndex === 'number' && Number.isFinite(data.failedStepIndex)
      ? data.failedStepIndex
      : detectedFailedStepIndex >= 0
        ? detectedFailedStepIndex
        : undefined;

  if (failedStepIndex !== undefined) {
    throw buildSequenceStepError(results, completedSteps, failedStepIndex);
  }

  const orientation = data.sequenceOrientation;
  return {
    results,
    completedSteps,
    failedStepIndex,
    ...(orientation === 1 || orientation === 2 || orientation === 3 || orientation === 4
      ? { sequenceOrientation: orientation }
      : {}),
  };
}

function buildSequenceStepError(
  results: RunnerSequenceStepResult[],
  completedSteps: number,
  failedStepIndex: number,
): AppError {
  const failed = results[failedStepIndex];
  const kind = failed?.kind ?? 'step';
  const message = failed?.errorMessage ?? `sequence step ${failedStepIndex} (${kind}) failed`;
  // A step code the runner keeps off the wire (such as SYNTHESIZED_GESTURE_OUTCOME_UNKNOWN) reads as
  // it does on a standalone command: COMMAND_FAILED with its runner code, reason, and dispatch.
  // `runApplePressSeries` turns it into `unknown` once an earlier step ran.
  const stepCode = toAppErrorCode(failed?.errorCode);
  const classification = classifyRunnerReportedError(failed?.errorCode);
  const diagnosticOnly = classification.code !== stepCode;
  return new AppError(diagnosticOnly ? classification.code : stepCode, message, {
    ...(diagnosticOnly
      ? {
          runnerErrorCode: failed?.errorCode,
          ...(classification.details.reason === undefined
            ? {}
            : { reason: classification.details.reason }),
        }
      : {}),
    // Only a step code that classifies a dispatch publishes one; a plain refusal or a code-less step
    // leaves it unset, as a sequence failure always did.
    ...(sequenceStepClassifiesDispatch(failed?.errorCode)
      ? { dispatched: classification.details.dispatched }
      : {}),
    failedStepIndex,
    failedStepKind: kind,
    completedSteps,
    sequenceResults: results,
    hint:
      failed?.errorHint ??
      'Run snapshot -i to inspect the current UI, then continue from the observed state.',
  });
}

function sequenceStepClassifiesDispatch(code: string | undefined): boolean {
  if (code === undefined) return false;
  // The outcome-unknown gesture code classifies on its own, exactly as it does on a standalone
  // command, even though its row keeps the `unknown` wire verdict.
  if (code === SYNTHESIZED_GESTURE_OUTCOME_UNKNOWN_RUNNER_CODE) return true;
  const row = runnerErrorCodeRow(code);
  return row !== undefined && row.dispatched !== 'unknown';
}

function readSequenceResults(value: unknown): RunnerSequenceStepResult[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      ok: record.ok === true,
      kind: typeof record.kind === 'string' ? record.kind : 'unknown',
      errorCode: typeof record.errorCode === 'string' ? record.errorCode : undefined,
      errorMessage: typeof record.errorMessage === 'string' ? record.errorMessage : undefined,
      errorHint: typeof record.errorHint === 'string' ? record.errorHint : undefined,
      gestureStartUptimeMs:
        typeof record.gestureStartUptimeMs === 'number' ? record.gestureStartUptimeMs : undefined,
      gestureEndUptimeMs:
        typeof record.gestureEndUptimeMs === 'number' ? record.gestureEndUptimeMs : undefined,
    };
  });
}

/**
 * True when the runner answered that it cannot run Apple's accessibility audit
 * (`NATIVE_AUDIT_UNAVAILABLE`): its OS is older than iOS 17, or it is not an iOS runner.
 */
export function isRunnerNativeAuditUnavailableError(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.details?.runnerErrorCode === ('NATIVE_AUDIT_UNAVAILABLE' satisfies RunnerTableErrorCode)
  );
}
