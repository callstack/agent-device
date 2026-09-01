import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { errorResponse } from './response.ts';
import { resolveBoundFocusRuntime } from './focus-runtime.ts';
import { resolveScreenshotGenericExecution } from './screenshot-runtime.ts';
import { resolveBoundScrollRuntime } from './scroll-runtime.ts';
import type { ScreenshotRuntimeBindings } from './screenshot-runtime-binding.ts';
import type { DaemonCommandContext } from './context.ts';
import type { DaemonRequest, SessionState } from './types.ts';
import { resolveBoundViewportRuntime } from './viewport-runtime.ts';
import { resolveBoundBackRuntime } from './back-runtime.ts';
import { resolveBoundHomeRuntime } from './home-runtime.ts';
import { resolveBoundAppSwitcherRuntime } from './app-switcher-runtime.ts';
import { resolveBoundOrientationRuntime } from './orientation-runtime.ts';
import { resolveBoundTvRemoteRuntime } from './tv-remote-runtime.ts';

/**
 * The generic route's runtime-owned leaves (ADR 0019). Each one admits its own exact owner facts
 * and binds once here, before the dispatcher runs, so the dispatcher itself never learns a command
 * name.
 *
 * Every generic-route descriptor is now runtime-owned (R58 retired the last legacy dispatcher), so
 * this is total over that route rather than a partial table with a legacy fallback behind it —
 * `generic-route-runtime-completeness.test.ts` derives the denominator from the registry and fails
 * if a descriptor joins the route without an arm here. The `default` therefore reports a routing
 * gap; it is not a second execution path.
 */
export async function resolveGenericRuntimeExecution(
  params: Readonly<{
    req: DaemonRequest;
    session: SessionState;
    context: DaemonCommandContext;
  }> &
    ScreenshotRuntimeBindings,
): Promise<ResolvedGenericExecution> {
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
    case 'app-switcher':
      return await resolveBoundAppSwitcherRuntime({
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
      return {
        ok: false,
        response: errorResponse(
          'COMMAND_FAILED',
          `${params.req.command} has no runtime execution on the generic route`,
          { reason: 'generic-route-runtime-missing' },
        ),
      };
  }
}
