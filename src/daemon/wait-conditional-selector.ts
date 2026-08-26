import type { FindSelectorRuntimeOperations } from '@agent-device/contracts/selector-observation-runtime';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { readSimpleSelectorTarget } from '@agent-device/selectors';
import { getRequestSignal } from '../request/cancel.ts';
import { buildRuntimeCaptureInput } from './snapshot-runtime-capture-input.ts';
import { recordIfSession, stripSelectorChain } from './selector-recording.ts';
import { isSessionRecording } from './session-script-publication-capability.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';

/**
 * Tries the admitted owner's one-sided native observation for an immediate simple-selector wait.
 * Any non-positive answer returns control to the required canonical capture in the same request.
 */
export async function dispatchConditionalWaitSelector(
  input: Readonly<{
    selectorExpression: string;
    operation: FindSelectorRuntimeOperations['findSelector'] | undefined;
    recordedLandmark: TargetAnnotationV1 | undefined;
    req: DaemonRequest;
    session: SessionState | undefined;
    sessionName: string;
    sessionStore: SessionStore;
    logPath: string | undefined;
    signal?: AbortSignal;
  }>,
): Promise<DaemonResponse | null> {
  if (
    !input.operation ||
    !input.session?.appBundleId ||
    input.recordedLandmark ||
    isSessionRecording(input.session)
  ) {
    return null;
  }
  const selector = readSimpleSelectorTarget(input.selectorExpression);
  if (!selector) return null;
  const startedAt = Date.now();
  const result = await input.operation({
    selector: { key: selector.key, value: selector.value },
    options: {
      appBundleId: input.session.appBundleId,
      surface: input.session.surface,
    },
    execution: buildRuntimeCaptureInput({
      flags: input.req.flags,
      logPath: input.logPath ?? '',
      meta: input.req.meta,
      session: input.session,
      snapshotScope: undefined,
    }).execution,
    signal: input.signal ?? getRequestSignal(input.req.meta?.requestId),
  });
  if (!result.found) return null;
  const payload = {
    kind: 'selector',
    selector: selector.raw,
    waitedMs: Date.now() - startedAt,
    selectorChain: [selector.raw],
  };
  recordIfSession(input.sessionStore, input.sessionName, input.req, payload);
  return { ok: true, data: stripSelectorChain(payload) };
}
