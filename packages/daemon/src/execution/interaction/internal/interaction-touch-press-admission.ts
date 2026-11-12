import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { InteractionTarget } from '@agent-device/contracts/interaction';
import {
  buttonTag,
  getClickButtonValidationError,
  resolveClickButton,
} from '@agent-device/contracts/click-button';
import { publicPlatformString } from '@agent-device/kernel/device';
import { resolveRefStalenessWarning } from '../../session-snapshot.ts';
import { isSessionRecording } from '../../../core/session-script-publication-capability.ts';
import { readRefMutationFrame } from '../../../core/ref-frame.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { refMutationAdmissionResponse } from './interaction-ref-policy.ts';
import { refusedBeforeDispatch } from '../../request-dispatch-disclosure.ts';
import { settleFlagGuardResponse } from './interaction-flags.ts';
import type {
  CaptureSnapshotForSession,
  InteractionRouteInput,
  RefSnapshotFlagGuardResponse,
} from '../../../core/interaction/internal/types.ts';
import type { RefAdmissionContext } from './interaction-touch-android-readiness.ts';
import { unsupportedMacOsDesktopSurfaceInteraction } from './interaction-touch-policy.ts';
import {
  parseLongPressTarget,
  parseTouchTarget,
  type ParsedLongPressTarget,
  type ParsedTouchTarget,
} from './interaction-touch-targets.ts';
import { errorResponse, noActiveSessionError } from '@agent-device/kernel/contracts';

/**
 * Whether a targeted `press`/`click`/`longpress`/`hover` may act, and on what: macOS
 * surface and capability policy, click-option validation, target parsing, and
 * `@ref` staleness plus mutation admission (ADR 0014). Nothing here dispatches.
 */

export type TargetedTouchCommand = 'press' | 'click' | 'longpress' | 'hover';

/** The family members that take `--button`; longpress and hover have no button. */
const CLICK_BUTTON_COMMANDS: ReadonlySet<TargetedTouchCommand> = new Set(['press', 'click']);

export type TargetedTouchParams = InteractionRouteInput & {
  captureSnapshotForSession: CaptureSnapshotForSession;
  refSnapshotFlagGuardResponse: RefSnapshotFlagGuardResponse;
};

/** What survives admission: the target this dispatch acts on and its policy context. */
export type AdmittedTargetedTouch = {
  session: SessionState;
  commandLabel: TargetedTouchCommand;
  clickButton: ReturnType<typeof resolveClickButton>;
  resultButtonTag: ReturnType<typeof buttonTag>;
  target: InteractionTarget;
  durationMs: number | undefined;
  staleRefsWarning: string | undefined;
  refContext: RefAdmissionContext | undefined;
  /** Multi-ref press plan members in dispatch order, bare bodies; absent for a single-ref target. */
  refs: readonly string[] | undefined;
};

type ParsedTargetedTouch = Extract<ParsedTouchTarget | ParsedLongPressTarget, { ok: true }>;

export async function admitTargetedTouch(
  params: TargetedTouchParams,
  command: TargetedTouchCommand,
): Promise<{ response: DaemonResponse } | { admitted: AdmittedTargetedTouch }> {
  const admission = await readTargetedTouchAdmission(params, command);
  return 'response' in admission
    ? { response: refusedBeforeDispatch(admission.response) }
    : admission;
}

async function readTargetedTouchAdmission(
  params: TargetedTouchParams,
  command: TargetedTouchCommand,
): Promise<{ response: DaemonResponse } | { admitted: AdmittedTargetedTouch }> {
  const { req, sessionStore, sessionName } = params;
  const session = sessionStore.get(sessionName);
  if (!session) return { response: noActiveSessionError() };

  const commandLabel = command === 'click' ? 'click' : command;
  const policyResponse = targetedTouchPolicyResponse(session, command, commandLabel, req.flags);
  if (policyResponse) return { response: policyResponse };

  const positionals = req.positionals ?? [];
  const parsedTarget =
    command === 'longpress'
      ? parseLongPressTarget(positionals)
      : parseTouchTarget(positionals, commandLabel);
  if (!parsedTarget.ok) return { response: parsedTarget.response };
  const sequenceGuardResponse = sequenceRecordingGuardResponse(session, req, parsedTarget);
  if (sequenceGuardResponse) return { response: sequenceGuardResponse };
  const staleRefsWarning = readTargetedTouchStalenessWarning(session, req, parsedTarget);
  const refAdmission = admitTargetedTouchRef(
    params,
    session,
    command,
    parsedTarget,
    staleRefsWarning,
  );
  if (refAdmission.response) return { response: refAdmission.response };

  const clickButton = resolveClickButton(req.flags);
  return {
    admitted: {
      session,
      commandLabel,
      clickButton,
      resultButtonTag: buttonTag(clickButton),
      target: parsedTarget.target,
      durationMs: command === 'longpress' ? parsedTarget.durationMs : undefined,
      staleRefsWarning,
      refContext: readRefAdmissionContext(req, parsedTarget, staleRefsWarning),
      refs: parsedTarget.refs,
    },
  };
}

/** Surface, capability, settle, and click-button policy, in that order. */
function targetedTouchPolicyResponse(
  session: SessionState,
  command: TargetedTouchCommand,
  commandLabel: TargetedTouchCommand,
  flags: CommandFlags | undefined,
): DaemonResponse | undefined {
  const unsupportedSurfaceResponse = unsupportedMacOsDesktopSurfaceInteraction(
    session,
    commandLabel,
  );
  if (unsupportedSurfaceResponse) return unsupportedSurfaceResponse;
  const invalidSettleFlags = settleFlagGuardResponse(command, flags);
  if (invalidSettleFlags) return invalidSettleFlags;
  return clickButtonValidationResponse(session, command, commandLabel, flags);
}

function clickButtonValidationResponse(
  session: SessionState,
  command: TargetedTouchCommand,
  commandLabel: TargetedTouchCommand,
  flags: CommandFlags | undefined,
): DaemonResponse | undefined {
  const clickButton = resolveClickButton(flags);
  if (!CLICK_BUTTON_COMMANDS.has(command) || clickButton === 'primary') return undefined;
  const validationError = getClickButtonValidationError({
    commandLabel,
    platform: publicPlatformString(session.device),
    button: clickButton,
    count: flags?.count,
    intervalMs: flags?.intervalMs,
    holdMs: flags?.holdMs,
    jitterPx: flags?.jitterPx,
    doubleTap: flags?.doubleTap,
  });
  if (!validationError) return undefined;
  return errorResponse(validationError.code, validationError.message, validationError.details);
}

/**
 * Staleness relative to what the client knew when it sent this @ref — read
 * BEFORE any internal recapture (Android freshness refresh, --verify) advances
 * the generation as a side effect of this same command. Pinned refs
 * (`@e12~s3`) get a precise generation-mismatch warning; a plain ref warns
 * while the frame is expired. A mutating `find`'s internal dispatch supplies a
 * locator-minted ref (`internal.findResolvedTarget`), so it carries no
 * user-facing staleness — the caller never consumed a `@ref` (ADR 0014).
 * A multi-ref plan warns per member; distinct warnings join in dispatch order.
 */
function readTargetedTouchStalenessWarning(
  session: SessionState,
  req: InteractionRouteInput['req'],
  parsedTarget: ParsedTargetedTouch,
): string | undefined {
  if (parsedTarget.target.kind !== 'ref') return undefined;
  if (req.internal?.findResolvedTarget !== undefined) return undefined;
  if (parsedTarget.refs) {
    const warnings = new Set<string>();
    parsedTarget.refs.forEach((ref, index) => {
      const warning = resolveRefStalenessWarning({
        session,
        ref: `@${ref}`,
        mintedGeneration: parsedTarget.refGenerations?.[index],
      });
      if (warning) warnings.add(warning);
    });
    return warnings.size > 0 ? Array.from(warnings).join(' ') : undefined;
  }
  return resolveRefStalenessWarning({
    session,
    ref: parsedTarget.target.ref,
    mintedGeneration: parsedTarget.refGeneration,
  });
}

/**
 * A multi-ref press plan can be neither recorded nor replayed through a target
 * guard. The recorder binds one target (and its recording-time evidence) to
 * each recorded step, and a guarded replay dispatch resolves through the
 * single-ref path — a plan that slipped into either shape would replay its
 * first key only and report the remaining keys as sent. Refusing at admission
 * keeps the refusal pre-dispatch: the frame keeps its pre-command state.
 */
function sequenceRecordingGuardResponse(
  session: SessionState,
  req: InteractionRouteInput['req'],
  parsedTarget: ParsedTargetedTouch,
): DaemonResponse | undefined {
  if (!parsedTarget.refs) return undefined;
  if (isSessionRecording(session) && !req.flags?.noRecord) {
    return errorResponse(
      'INVALID_ARGS',
      'A multi-ref press sequence cannot be recorded: the recorder binds one target per step, so the recorded step would press only the first key. Record one press per key, or pass --no-record on this step.',
      { reason: 'sequence-recording-unsupported' },
    );
  }
  if (req.internal?.replayTargetGuard !== undefined) {
    return errorResponse(
      'INVALID_ARGS',
      'A multi-ref press sequence cannot carry a replay target guard: the guard binds one target, so the replayed step would press only the first key. Re-record the journey as one press per key.',
      { reason: 'sequence-replay-guard-unsupported' },
    );
  }
  return undefined;
}

function readRefAdmissionContext(
  req: InteractionRouteInput['req'],
  parsedTarget: ParsedTargetedTouch,
  staleRefsWarning: string | undefined,
): RefAdmissionContext | undefined {
  if (parsedTarget.target.kind !== 'ref') return undefined;
  if (req.internal?.findResolvedTarget !== undefined) return undefined;
  return {
    ref: parsedTarget.target.ref,
    mintedGeneration: parsedTarget.refGeneration,
    staleRefsWarning,
  };
}

function admitTargetedTouchRef(
  params: TargetedTouchParams,
  session: SessionState,
  command: TargetedTouchCommand,
  parsedTarget: ParsedTargetedTouch,
  staleRefsWarning: string | undefined,
): { response?: DaemonResponse } {
  const { req } = params;
  if (parsedTarget.target.kind !== 'ref') return {};
  const invalidRefFlagsResponse = params.refSnapshotFlagGuardResponse(
    command === 'click' ? 'press' : command,
    req.flags,
  );
  if (invalidRefFlagsResponse) return { response: invalidRefFlagsResponse };
  if (req.internal?.findResolvedTarget) return {};
  // ADR 0014: every member of a multi-ref plan is admitted against the active
  // frame before the first dispatch, so a plan one key cannot authorize
  // refuses whole and the frame keeps its pre-command state.
  const members: { ref: string; mintedGeneration: number | undefined }[] = parsedTarget.refs
    ? parsedTarget.refs.map((ref, index) => ({
        ref: `@${ref}`,
        mintedGeneration: parsedTarget.refGenerations?.[index],
      }))
    : [
        {
          ref: parsedTarget.target.ref,
          mintedGeneration: parsedTarget.refGeneration,
        },
      ];
  for (const member of members) {
    const admissionResponse = refMutationAdmissionResponse({
      ref: member.ref,
      mintedGeneration: member.mintedGeneration,
      staleRefsWarning,
      frame: readRefMutationFrame({
        session,
        ref: member.ref,
        mintedGeneration: member.mintedGeneration,
      }),
    });
    if (admissionResponse) return { response: admissionResponse };
  }
  return {};
}
