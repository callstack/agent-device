import { inspectMaestroFlow } from '@agent-device/maestro';
import { parseReplayInput, resolveReplayFormat } from '@agent-device/ad-script';
import type { ResolveTargetDeviceOptions } from '@agent-device/device-selection/dispatch-resolve';
import type { CommandFlags } from '@agent-device/contracts/command';
import { readReplayScriptSourceFile } from './replay-script-source.ts';
import type { DaemonRequest } from './daemon-request.ts';
import {
  appTargetResolutionOptions,
  buildMaestroReplayTargetDeviceResolutionOptions,
  buildReplayScriptPlatformFlags,
  readScriptReplaySelection,
} from './replay/index.ts';

export type ReplayTargetDeviceResolution = {
  flags: CommandFlags;
  options: ResolveTargetDeviceOptions | undefined;
};

/**
 * Finds a static first app target for fresh replay binding. Request binding
 * must leave a first deep-link or dynamic open to normal device resolution.
 *
 * #1802: reads the request's replay script source bundle, never the
 * filesystem. Before that this opened the caller's path here too, so against a
 * remote daemon it silently no-opped (the read threw and the catch below
 * swallowed it) and every remote replay lost its pre-binding.
 */
export function buildReplayTargetDeviceResolution(
  req: DaemonRequest,
): ReplayTargetDeviceResolution | undefined {
  if (req.command !== 'replay' || req.flags?.replayFrom !== undefined) return undefined;
  const bundle = req.flags?.replayScriptSource;
  if (!bundle) return undefined;

  try {
    const resolved = bundle.entry;
    const source = readReplayScriptSourceFile(bundle, resolved);
    if (resolveReplayFormat(resolved, req.flags?.replayBackend) === 'maestro') {
      const flow = inspectMaestroFlow(source, resolved);
      return {
        flags: req.flags ?? {},
        options: buildMaestroReplayTargetDeviceResolutionOptions(
          flow.appTarget,
          req.flags?.platform,
        ),
      };
    }
    const parsed = parseReplayInput(source, req.flags);
    const selection = readScriptReplaySelection(parsed.actions);
    if (!selection.appTarget) return undefined;
    const scriptFlags = buildReplayScriptPlatformFlags(req.flags, parsed.actions);
    const platform = scriptFlags.platform ?? parsed.metadata.platform;
    return {
      flags:
        platform && scriptFlags.platform === undefined ? { ...scriptFlags, platform } : scriptFlags,
      options: platform === 'ios' ? appTargetResolutionOptions(selection.appTarget) : undefined,
    };
  } catch {
    // Parsing and validation stay in the replay handler. Lock binding is only
    // advisory, so an unreadable/invalid plan must not mask its real error.
    return undefined;
  }
}
