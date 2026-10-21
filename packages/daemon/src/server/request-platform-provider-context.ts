import type { PlatformProviderRequestContext } from '@agent-device/contracts/platform-providers';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import {
  hasDeviceSelectionInput,
  hasExplicitDeviceSelector,
} from '../core/device/device-selector-intent.ts';
import { buildOpenTargetDeviceResolutionOptions } from '@agent-device/device-selection/open-target';
import { resolveProviderDeviceResolutionIntent } from '../core/daemon-command-registry.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionState } from '../core/session-state.ts';

/**
 * Resolves the daemon-owned part of the request-provider seam.
 *
 * Provider implementations receive a neutral context from the root composition. In particular,
 * they never receive a DaemonRequest or SessionState: those types contain daemon-only callbacks
 * and lifecycle state. An unresolvable provider device intentionally produces no context; command
 * admission remains responsible for reporting the request's device-resolution error.
 */
export async function resolvePlatformProviderRequestContext(params: {
  req: DaemonRequest;
  existingSession: SessionState | undefined;
  env: EnvMap;
  useDefaultWebProvider?: boolean;
}): Promise<PlatformProviderRequestContext | undefined> {
  const device = await resolveScopedProviderDevice(params.req, params.existingSession, params.env);
  if (!device) return undefined;

  return {
    device,
    ...(params.req.session !== undefined ? { requestedSession: params.req.session } : {}),
    ...(params.req.meta?.requestId !== undefined ? { requestId: params.req.meta.requestId } : {}),
    ...(params.existingSession
      ? {
          session: {
            name: params.existingSession.name,
            device: params.existingSession.device,
            ...(params.existingSession.appBundleId
              ? { appBundleId: params.existingSession.appBundleId }
              : {}),
            ...(params.existingSession.appName ? { appName: params.existingSession.appName } : {}),
            ...(params.existingSession.surface ? { surface: params.existingSession.surface } : {}),
          },
        }
      : {}),
    ...(params.useDefaultWebProvider ? { useDefaultWebProvider: true } : {}),
  };
}

async function resolveScopedProviderDevice(
  req: DaemonRequest,
  existingSession: SessionState | undefined,
  env: EnvMap,
): Promise<SessionState['device'] | undefined> {
  const intent = resolveProviderDeviceResolutionIntent(req, {
    hasExistingSession: Boolean(existingSession),
    hasExplicitDeviceIdentity: hasExplicitDeviceSelector(req.flags),
    hasDeviceSelectionInput: hasDeviceSelectionInput(req.flags),
  });
  switch (intent) {
    case 'existing-session':
      return existingSession?.device;
    case 'explicit-device':
    case 'sessionless-default-device':
      // Provider-scope plumbing only: an unresolvable device means "no provider scope for this
      // request", never a failed request. The command's own device resolution reports errors.
      try {
        return await resolveProviderTargetDevice(req, env);
      } catch {
        return undefined;
      }
    case 'skip':
      return undefined;
  }
}

async function resolveProviderTargetDevice(
  req: DaemonRequest,
  env: EnvMap,
): Promise<SessionState['device']> {
  const options =
    req.command === 'open'
      ? buildOpenTargetDeviceResolutionOptions(req.positionals?.[0], env, req.flags?.surface)
      : undefined;
  return await resolveTargetDevice(req.flags ?? {}, { ...options, env });
}
