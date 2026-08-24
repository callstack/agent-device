import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundFocusRuntime } from './focus-runtime.ts';
import { resolveScreenshotGenericExecution } from './screenshot-runtime.ts';
import { resolveBoundScrollRuntime } from './scroll-runtime.ts';
import type { ScreenshotRuntimeBindings } from './screenshot-runtime-binding.ts';
import type { DaemonCommandContext } from './context.ts';
import type { DaemonRequest, SessionState } from './types.ts';
import { resolveBoundViewportRuntime } from './viewport-runtime.ts';
import { resolveBoundBackRuntime } from './back-runtime.ts';
import { resolveBoundHomeRuntime } from './home-runtime.ts';
import { resolveBoundOrientationRuntime } from './orientation-runtime.ts';
import { resolveBoundTvRemoteRuntime } from './tv-remote-runtime.ts';

/**
 * The generic route's runtime-owned leaves (ADR 0019). Each one admits its own exact owner facts
 * and binds once here, before the dispatcher runs, so the dispatcher itself never learns a command
 * name. `undefined` means the leaf still executes through legacy platform dispatch.
 */
export async function resolveGenericRuntimeExecution(
  params: Readonly<{
    req: DaemonRequest;
    session: SessionState;
    context: DaemonCommandContext;
  }> &
    ScreenshotRuntimeBindings,
): Promise<ResolvedGenericExecution | undefined> {
  switch (params.req.command) {
    case 'screenshot':
      return await resolveScreenshotGenericExecution(params);
    case 'focus':
      return await resolveBoundFocusRuntime({
        device: params.session.device,
        positionals: params.req.positionals ?? [],
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
      });
    case 'scroll':
      return await resolveBoundScrollRuntime({
        device: params.session.device,
        positionals: params.req.positionals ?? [],
        context: params.context,
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
      });
    case 'viewport':
      return await resolveBoundViewportRuntime({
        device: params.session.device,
        positionals: params.req.positionals ?? [],
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
      });
    case 'back':
      return await resolveBoundBackRuntime({
        device: params.session.device,
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
      });
    case 'home':
      return await resolveBoundHomeRuntime({
        device: params.session.device,
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
      });
    case 'orientation':
      return await resolveBoundOrientationRuntime({
        device: params.session.device,
        positionals: params.req.positionals ?? [],
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
      });
    case 'tv-remote':
      return await resolveBoundTvRemoteRuntime({
        device: params.session.device,
        positionals: params.req.positionals ?? [],
        durationMs: params.req.flags?.durationMs,
        inspectFacts: params.inspectFacts,
        bindDevice: params.bindDevice,
      });
    default:
      return undefined;
  }
}
