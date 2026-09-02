import type {
  AgentDeviceRuntime,
  CommandContext,
  CommandSessionRecord,
} from '../../../runtime-contract.ts';
import type { BackendSnapshotResult } from '../../../backend.ts';
import { AppError } from '@agent-device/kernel/errors';
import type {
  SnapshotNode,
  SnapshotPreferredBackend,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { findNodeByRef, normalizeRef } from '@agent-device/kernel/snapshot';
import { isSparseSnapshotQualityVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';
import { extractReadableText } from '../../../snapshot/snapshot-presentation/text-surface.ts';
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
  if (!node) throw new AppError('COMMAND_FAILED', options.notFoundMessage);
  return { ref, node };
}
