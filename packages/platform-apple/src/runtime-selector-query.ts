import type {
  QuerySelectorInput,
  QuerySelectorNodeReading,
  QuerySelectorResult,
  SelectorObservationRuntimeOperations,
} from '@agent-device/contracts/selector-observation-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { parseRect } from '@agent-device/kernel/record';
import type { RunnerCallOptions } from '@agent-device/contracts/interactor-types';

type AppleSelectorQueryRequest = Readonly<{
  device: DeviceInfo;
  signal: AbortSignal;
}>;

/**
 * The runner's live, tree-independent node read. The daemon never asks the runner a question
 * itself: an owner that exposes this conditional operation answers with the geometry the runner
 * measured right now, which is what lets the shared off-screen guard (#1542) overturn a false
 * refusal produced by a stale bulk tree. A refusal or a miss stays a miss — this read rescues,
 * it never relaxes a genuine verdict, and it never mutates the device.
 *
 * The runner is scoped to an application when the request names one, exactly as the retired
 * daemon-side probe scoped its own call; an unscoped query keeps the runner's own semantics.
 */
export function bindAppleQuerySelectorRuntime(
  request: AppleSelectorQueryRequest,
): Pick<SelectorObservationRuntimeOperations, 'querySelector'> {
  return Object.freeze({
    querySelector: async (input: QuerySelectorInput): Promise<QuerySelectorResult> => {
      const signal = input.signal
        ? AbortSignal.any([request.signal, input.signal])
        : request.signal;
      signal.throwIfAborted();
      // Same projection bindAppleFindTextRuntime builds: the execution context is exactly the
      // runner-call fields, with the composed signal replacing the caller's own.
      const options: RunnerCallOptions = { ...input.execution, signal };
      // Deferred exactly like the retired daemon-side edge: the runner client binds its host at
      // evaluation, so mechanics load on the first read, never with the runtime façade.
      const { queryAppleRunnerSelector } = await import('./core/runner-selector-query.ts');
      const data = await queryAppleRunnerSelector(
        request.device,
        input.selector,
        input.options?.appBundleId,
        options,
      );
      const node = readQuerySelectorNode(data);
      return Object.freeze({
        found: data.found === true,
        ...(node ? { node } : {}),
      });
    },
  });
}

function readQuerySelectorNode(
  data: Record<string, unknown>,
): QuerySelectorNodeReading | undefined {
  const nodes = data.nodes;
  if (!Array.isArray(nodes)) return undefined;
  const node = nodes[0];
  if (!node || typeof node !== 'object') return undefined;
  const rect = parseRect((node as { rect?: unknown }).rect);
  if (!rect) return undefined;
  return Object.freeze({
    rect,
    hittable: (node as { hittable?: unknown }).hittable === true,
  });
}
