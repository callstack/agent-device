import type { CommandFlags } from '@agent-device/contracts/command';
import type { InteractionTarget } from '@agent-device/contracts/interaction';
import {
  buttonTag,
  getClickButtonValidationError,
  resolveClickButton,
} from '@agent-device/contracts/click-button';
import { publicPlatformString } from '@agent-device/kernel/device';
import { resolveRefStalenessWarning } from '../session-snapshot.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import { settleFlagGuardResponse, type RefSnapshotFlagGuardResponse } from './interaction-flags.ts';
import { refMutationAdmissionResponse } from './interaction-ref-policy.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import type { RefAdmissionContext } from './interaction-touch-android-readiness.ts';
import { unsupportedMacOsDesktopSurfaceInteraction } from './interaction-touch-policy.ts';
import {
  parseLongPressTarget,
  parseTouchTarget,
  type ParsedLongPressTarget,
  type ParsedTouchTarget,
} from './interaction-touch-targets.ts';
import { errorResponse, noActiveSessionError } from './response.ts';

/**
 * Whether a targeted `press`/`click`/`longpress`/`hover` may act, and on what: macOS
 * surface and capability policy, click-option validation, target parsing, and
 * `@ref` staleness plus mutation admission (ADR 0014). Nothing here dispatches.
 */

export type TargetedTouchCommand = 'press' | 'click' | 'longpress' | 'hover';

/** The family members that take `--button`; longpress and hover have no button. */
const CLICK_BUTTON_COMMANDS: ReadonlySet<TargetedTouchCommand> = new Set(['press', 'click']);

export type TargetedTouchParams = InteractionHandlerParams & {
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
};

type ParsedTargetedTouch = Extract<ParsedTouchTarget | ParsedLongPressTarget, { ok: true }>;

export async function admitTargetedTouch(
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
 */
function readTargetedTouchStalenessWarning(
  session: SessionState,
  req: InteractionHandlerParams['req'],
  parsedTarget: ParsedTargetedTouch,
): string | undefined {
  if (parsedTarget.target.kind !== 'ref') return undefined;
  if (req.internal?.findResolvedTarget !== undefined) return undefined;
  return resolveRefStalenessWarning({
    session,
    ref: parsedTarget.target.ref,
    mintedGeneration: parsedTarget.refGeneration,
  });
}

function readRefAdmissionContext(
  req: InteractionHandlerParams['req'],
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
  const admissionResponse = req.internal?.findResolvedTarget
    ? null
    : refMutationAdmissionResponse({
        session,
        ref: parsedTarget.target.ref,
        mintedGeneration: parsedTarget.refGeneration,
        staleRefsWarning,
      });
  if (admissionResponse) return { response: admissionResponse };
  return {};
}
