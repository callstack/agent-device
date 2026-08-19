import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveScreenshotGenericExecution } from './screenshot-runtime.ts';
import type { ScreenshotRuntimeBindings } from './screenshot-runtime-binding.ts';
import type { DaemonRequest, SessionState } from './types.ts';
import { resolveBoundViewportRuntime } from './viewport-runtime.ts';

/**
 * The generic route's runtime-owned leaves (ADR 0019). Each one admits its own exact owner facts
 * and binds once here, before the dispatcher runs, so the dispatcher itself never learns a command
 * name. `undefined` means the leaf still executes through legacy platform dispatch.
 */
export async function resolveGenericRuntimeExecution(
  params: Readonly<{ req: DaemonRequest; session: SessionState }> & ScreenshotRuntimeBindings,
): Promise<ResolvedGenericExecution | undefined> {
  switch (params.req.command) {
    case 'screenshot':
      return await resolveScreenshotGenericExecution(params);
    case 'viewport':
      return await resolveBoundViewportRuntime({
        device: params.session.device,
        positionals: params.req.positionals ?? [],
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
      });
    default:
      return undefined;
  }
}
