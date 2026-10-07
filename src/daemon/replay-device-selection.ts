import { parseReplayInput, resolveReplayFormat } from '@agent-device/ad-script';
import type { ResolveTargetDeviceOptions } from '@agent-device/device-selection/dispatch-resolve';
import type { CommandFlags } from '@agent-device/contracts/command';
import { readReplayScriptSourceFile } from '@agent-device/replay-port/script-source';
import type { DaemonRequest } from './daemon-request.ts';
import {
  appTargetResolutionOptions,
  buildMaestroReplayTargetDeviceResolutionOptions,
  buildReplayScriptPlatformFlags,
  readScriptReplaySelection,
} from '@agent-device/replay-port/replay-script-selection';

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
 *
 * The Maestro engine loads only once the entry resolves to a flow: request
 * binding is in the daemon's startup closure, and most replays are `.ad`.
 */
export async function buildReplayTargetDeviceResolution(
  req: DaemonRequest,
): Promise<ReplayTargetDeviceResolution | undefined> {
  if (req.command !== 'replay' || req.flags?.replayFrom !== undefined) return undefined;
  const bundle = req.flags?.replayScriptSource;
  if (!bundle) return undefined;

  return readAdvisoryResolution(async () => {
    const resolved = bundle.entry;
    const source = readReplayScriptSourceFile(bundle, resolved);
    if (resolveReplayFormat(resolved, req.flags?.replayBackend) === 'maestro') {
      return await readMaestroReplayResolution(source, resolved, req.flags);
    }
    return readAdScriptResolution(source, req.flags);
  });
}

async function readMaestroReplayResolution(
  source: string,
  resolvedPath: string,
  flags: DaemonRequest['flags'],
): Promise<ReplayTargetDeviceResolution> {
  const { inspectMaestroFlow } = await import('@agent-device/maestro');
  const flow = inspectMaestroFlow(source, resolvedPath);
  return {
    flags: flags ?? {},
    options: buildMaestroReplayTargetDeviceResolutionOptions(flow.appTarget, flags?.platform),
  };
}

function readAdScriptResolution(
  source: string,
  flags: DaemonRequest['flags'],
): ReplayTargetDeviceResolution | undefined {
  const parsed = parseReplayInput(source, flags);
  const selection = readScriptReplaySelection(parsed.actions);
  if (!selection.appTarget) return undefined;
  const scriptFlags = buildReplayScriptPlatformFlags(flags, parsed.actions);
  const platform = scriptFlags.platform ?? parsed.metadata.platform;
  return {
    flags:
      platform && scriptFlags.platform === undefined ? { ...scriptFlags, platform } : scriptFlags,
    options: platform === 'ios' ? appTargetResolutionOptions(selection.appTarget) : undefined,
  };
}

async function readAdvisoryResolution(
  read: () => Promise<ReplayTargetDeviceResolution | undefined>,
): Promise<ReplayTargetDeviceResolution | undefined> {
  try {
    return await read();
  } catch {
    // Parsing and validation stay in the replay handler. Lock binding is only
    // advisory, so an unreadable/invalid plan must not mask its real error. The
    // whole probe sits behind this guard, including the wire bundle's entry and
    // format, which the request boundary only checks as an object.
    return undefined;
  }
}
