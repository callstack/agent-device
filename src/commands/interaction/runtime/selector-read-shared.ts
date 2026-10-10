import type {
  AgentDeviceRuntime,
  CommandContext,
  CommandSessionRecord,
} from '@agent-device/contracts/runtime-contract';
import type { BackendSnapshotResult } from '@agent-device/contracts/backend';
import {
  AppError,
  discloseDispatch,
  type AppErrorDetails,
  type DispatchDisclosure,
} from '@agent-device/kernel/errors';
import type {
  SnapshotNode,
  SnapshotPreferredBackend,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { findNodeByRef, normalizeRef } from '@agent-device/kernel/snapshot';
import {
  formatSelectorFailure,
  selectorFailureHint,
  STALE_REF_HINT,
  type SelectorResolution,
} from '@agent-device/selectors';
import type { SelectorPipelineOutcome } from '@agent-device/selectors/selector-pipeline';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { elementMatchCandidateDetails } from '@agent-device/capture-kit/snapshot-lines';
import { isSparseSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { extractReadableText } from '@agent-device/capture-kit/text-surface';
import { now, toBackendContext } from '../../runtime-common.ts';
import { findNodeByLabel } from './selector-read-utils.ts';
import type { SelectorSnapshotInput } from '../../command-input.ts';

export type CapturedSnapshot = {
  sessionName: string;
  session?: CommandSessionRecord;
  snapshot: SnapshotState;
};

export type SelectorSnapshotOptions = SelectorSnapshotInput;

/**
 * Resolve the snapshot a `@ref` READ binds against. ADR 0014: a ref resolves
 * against the AUTHORIZED frame tree (`refFrameSnapshot`), never the latest
 * operational observation — so an internal read-only capture that replaced the
 * observation cannot let a plain `@eN` resolve a different element by positional
 * coincidence. Missing frame evidence fails (the ref is simply not found in the
 * retained tree) rather than falling through to a newer observation. Only used
 * by ref reads; selector reads capture fresh through `captureSelectorSnapshot`.
 */
export async function requireSnapshotSession(
  runtime: AgentDeviceRuntime,
  requestedName: string | undefined,
): Promise<CapturedSnapshot & { session: CommandSessionRecord }> {
  const sessionName = requestedName ?? 'default';
  const session = await runtime.sessions.get(sessionName);
  if (!session) throw new AppError('SESSION_NOT_FOUND', 'No active session. Run open first.');
  const frameTree = session.refFrameSnapshot ?? session.snapshot;
  if (!frameTree) {
    throw new AppError('INVALID_ARGS', 'No snapshot in session. Run snapshot first.');
  }
  return { sessionName, session, snapshot: frameTree };
}

export async function captureSelectorSnapshot(
  runtime: AgentDeviceRuntime,
  options: CommandContext & SelectorSnapshotOptions,
  captureOptions: {
    updateSession: boolean;
    scope?: string;
    includeRects?: boolean;
    interactiveOnly?: boolean;
    includeHiddenContentHints?: boolean;
    preferredBackend?: SnapshotPreferredBackend;
  } = {
    updateSession: true,
  },
): Promise<CapturedSnapshot> {
  const captureSnapshot = runtime.backend.captureSnapshot;
  if (!captureSnapshot) {
    throw new AppError('UNSUPPORTED_OPERATION', 'snapshot is not supported by this backend');
  }
  const sessionName = options.session ?? 'default';
  const session = await runtime.sessions.get(sessionName);
  const result = await captureSnapshot(toBackendContext(runtime, options), {
    interactiveOnly: captureOptions.interactiveOnly ?? false,
    depth: options.depth,
    scope: captureOptions.scope ?? options.scope,
    raw: options.raw,
    includeRects: captureOptions.includeRects,
    ...(captureOptions.preferredBackend
      ? { preferredBackend: captureOptions.preferredBackend }
      : {}),
    ...(captureOptions.includeHiddenContentHints !== undefined
      ? { includeHiddenContentHints: captureOptions.includeHiddenContentHints }
      : {}),
  });
  const snapshot = snapshotStateFromResult(result, runtime);
  (options.signal ?? runtime.signal)?.throwIfAborted();
  if (
    captureOptions.updateSession &&
    session &&
    !isSparseSnapshotQualityVerdict(snapshot.snapshotQuality)
  ) {
    await runtime.sessions.set({ ...session, snapshot });
  }
  return { sessionName, session, snapshot };
}

function snapshotStateFromResult(
  result: BackendSnapshotResult,
  runtime: AgentDeviceRuntime,
): SnapshotState {
  if (result.snapshot) return mergeSnapshotAnnotations(result.snapshot, result);
  return {
    nodes: result.nodes ?? [],
    truncated: result.truncated,
    backend: result.backend as SnapshotState['backend'],
    ...(result.quality ? { snapshotQuality: result.quality } : {}),
    createdAt: now(runtime),
  } satisfies SnapshotState;
}

function mergeSnapshotAnnotations(
  snapshot: SnapshotState,
  result: BackendSnapshotResult,
): SnapshotState {
  const merged = { ...snapshot };
  if (result.truncated === true || merged.truncated === true) merged.truncated = true;
  else if (result.truncated !== undefined) merged.truncated = result.truncated;
  if (result.quality && merged.snapshotQuality === undefined) {
    merged.snapshotQuality = result.quality;
  }
  return merged;
}

export async function readText(
  runtime: AgentDeviceRuntime,
  capture: CapturedSnapshot,
  node: SnapshotNode,
): Promise<string> {
  if (runtime.backend.readText) {
    const result = await runtime.backend.readText(
      toBackendContext(runtime, {
        session: capture.sessionName,
      }),
      node,
    );
    if (result.text.trim()) return result.text;
  }
  return extractReadableText(node);
}

export function resolveRefNode(
  nodes: SnapshotState['nodes'],
  refInput: string,
  options: {
    fallbackLabel: string;
    invalidRefMessage: string;
    notFoundMessage: string;
  },
): { ref: string; node: SnapshotNode } {
  const ref = normalizeRef(refInput);
  if (!ref) throw new AppError('INVALID_ARGS', options.invalidRefMessage);
  const node =
    findNodeByRef(nodes, ref) ??
    (options.fallbackLabel.length > 0 ? findNodeByLabel(nodes, options.fallbackLabel) : null);
  if (!node) {
    throw new AppError('COMMAND_FAILED', options.notFoundMessage, {
      reason: INTERACTION_ERROR_REASONS.refNotFound,
      ref,
      hint: STALE_REF_HINT,
    });
  }
  return { ref, node };
}

/**
 * The one `selector_not_found` refusal shape shared by the acting rows and the
 * strict reads: COMMAND_FAILED, `formatSelectorFailure`'s message, the typed
 * reason, and `selectorFailureHint` — built once so a hint or message edit
 * cannot drift between routes. The two axes where those routes genuinely
 * differ on the wire stay explicit parameters: `unique` (message shape) and
 * `dispatched` (the acting route proves `'no'`; the read route proves nothing
 * about device dispatch and omits the field rather than asserting one).
 * Fixed contract fields (`reason`, `hint`) are written AFTER caller details so
 * no caller spread order can clobber them.
 */
export function selectorNotFoundFailure(
  selectorExpression: string,
  options: {
    /** The resolution diagnostics the message and hint read (empty: "did not match"). */
    diagnostics?: SelectorResolution['diagnostics'];
    unique?: boolean;
    dispatched?: DispatchDisclosure;
  } & AppErrorDetails,
): AppError {
  const { diagnostics = [], unique = true, dispatched, ...details } = options;
  const error = new AppError(
    'COMMAND_FAILED',
    formatSelectorFailure(selectorExpression, diagnostics, { unique }),
    {
      ...details,
      reason: INTERACTION_ERROR_REASONS.selectorNotFound,
      hint: selectorFailureHint(diagnostics),
    },
  );
  return dispatched === undefined ? error : discloseDispatch(error, dispatched);
}

/**
 * The ambiguity refusal never names the caller's whole expression: like the
 * acting refusal, it names the matched alternative, and the fixed contract
 * fields are written AFTER any caller details so a caller cannot clobber them.
 * `is` passes `predicate` and its authored expression (already reported by the
 * success payload); the authored expression loses to the matched alternative
 * here on purpose — that is what "which alternative matched twice" means.
 */
function selectorAmbiguousFailure(
  selector: string,
  matchedNodes: readonly SnapshotNode[],
  options: { command: string } & AppErrorDetails,
): AppError {
  const { command, ...details } = options;
  return new AppError(
    'AMBIGUOUS_MATCH',
    `Selector matched ${matchedNodes.length} elements: ${selector}`,
    {
      ...details,
      ...elementMatchCandidateDetails(matchedNodes),
      command,
      selector,
      // No `find '<selector>' list` echo here: an authored label can contain a
      // single quote, and a hard single-quoted re-run command is not CLI-safe.
      hint: `Narrow the selector with role/id/longer text, or act on a printed candidate with a command that takes refs, such as press.`,
    },
  );
}

/**
 * The shared failure door for the observation reads that refuse to guess which
 * element they mean (`is` predicates other than `exists`/`absent`, and
 * `get attrs` — both `readUnique` rows). The pipeline reports three distinct
 * refusals and they are three different facts about the screen, so the door
 * keys on the outcome kind, never on message text:
 *
 * - `none` — nothing matched: `selector_not_found`, which genuinely means the
 *   element is not in the tree.
 * - `ambiguous` — N nodes matched and the row refuses to choose:
 *   `AMBIGUOUS_MATCH`, the code the acting refusal already answers with
 *   (#2870: this used to be reported as `selector_not_found`, which to an
 *   agent reads as "the element does not exist" on a screen where it is
 *   plainly on display). What the two producers SHARE is the code and
 *   `elementMatchCandidateDetails` — the one disclosure builder (cap,
 *   snapshot-line renderer, `matches`/`candidates` keys) every surface already
 *   reads through `readErrorCandidateViews`; each keeps its own message and
 *   remaining details for its own command.
 * - `occluded` — the row ignores occlusion and cannot produce it; the caller
 *   keeps its own not-found shape.
 */
export function observationReadFailure(params: {
  outcome: SelectorPipelineOutcome;
  selectorExpression: string;
  command: string;
  details?: AppErrorDetails;
}): AppError {
  const { outcome, selectorExpression, command, details } = params;
  if (outcome.kind === 'ambiguous') {
    return selectorAmbiguousFailure(outcome.selector, outcome.matchedNodes, {
      command,
      ...details,
    });
  }
  return selectorNotFoundFailure(selectorExpression, { command, unique: true, ...details });
}
