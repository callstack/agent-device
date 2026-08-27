import type { PlatformProviderRequestContext } from '@agent-device/contracts/platform-providers';
import { resolveTargetDevice } from '../core/dispatch-resolve.ts';
import { hasDeviceSelectionInput, hasExplicitDeviceSelector } from './device-selector-intent.ts';
import { buildOpenTargetDeviceResolutionOptions } from './open-device-selection.ts';
import { resolveProviderDeviceResolutionIntent } from './daemon-command-registry.ts';
import type { DaemonRequest, SessionState } from './types.ts';

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
  useDefaultWebProvider?: boolean;
}): Promise<PlatformProviderRequestContext | undefined> {
  const device = await resolveScopedProviderDevice(params.req, params.existingSession);
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
        return await resolveProviderTargetDevice(req);
      } catch {
        return undefined;
      }
    case 'skip':
      return undefined;
  }
}

async function resolveProviderTargetDevice(req: DaemonRequest): Promise<SessionState['device']> {
  const options =
    req.command === 'open'
      ? buildOpenTargetDeviceResolutionOptions(req.positionals?.[0])
      : undefined;
  return await resolveTargetDevice(req.flags ?? {}, options);
}
