import fs from 'node:fs';
import { parseReplayInput } from '../compat/replay-input.ts';
import { parseMaestroProgram } from '../compat/maestro/program-ir-parser.ts';
import type { ResolveTargetDeviceOptions } from '../core/dispatch-resolve.ts';
import type { MaestroProgram } from '../compat/maestro/program-ir.ts';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import { appleSimulatorAppTargetForOpenTarget } from './open-device-selection.ts';
import { SessionStore } from './session-store.ts';
import type { CommandFlags } from '../core/dispatch.ts';
import type { DaemonRequest, SessionAction } from './types.ts';

export type ReplayTargetDeviceResolution = {
  flags: CommandFlags;
  options: ResolveTargetDeviceOptions | undefined;
};

/**
 * Finds a static first app target for fresh replay binding. Request binding
 * must leave a first deep-link or dynamic open to normal device resolution.
 */
export function buildReplayTargetDeviceResolution(
  req: DaemonRequest,
): ReplayTargetDeviceResolution | undefined {
  if (req.command !== 'replay' || req.flags?.replayFrom !== undefined) return undefined;
  const filePath = req.positionals?.[0];
  if (!filePath) return undefined;

  try {
    const resolved = SessionStore.expandHome(filePath, req.meta?.cwd);
    const source = fs.readFileSync(resolved, 'utf8');
    if (isMaestroReplay(req, resolved)) {
      return {
        flags: req.flags ?? {},
        options: buildMaestroReplayTargetDeviceResolutionOptions(
          parseMaestroProgram(source, { sourcePath: resolved }),
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

export function buildMaestroReplayTargetDeviceResolutionOptions(
  program: MaestroProgram,
  platform: CommandFlags['platform'] | undefined,
): ResolveTargetDeviceOptions {
  if (platform !== 'ios') return {};
  const appTarget = readMaestroReplayAppTarget(program);
  return appTargetResolutionOptions(appTarget) ?? {};
}

function isMaestroReplay(req: DaemonRequest, filePath: string): boolean {
  return (
    req.flags?.replayBackend === 'maestro' &&
    (filePath.endsWith('.yaml') || filePath.endsWith('.yml'))
  );
}

function readScriptReplaySelection(actions: SessionAction[]): {
  appTarget: string | undefined;
  platform: CommandFlags['platform'] | undefined;
} {
  let platform: CommandFlags['platform'] | undefined;
  for (const action of actions) {
    if (action.command === 'runtime' && action.flags.platform) {
      platform = action.flags.platform;
      continue;
    }
    if (action.command !== 'open') continue;
    platform = action.runtime?.platform ?? platform;
    const target = action.positionals?.[0];
    if (isStaticAppTarget(target)) return { appTarget: target, platform };
    return { appTarget: undefined, platform };
  }
  return { appTarget: undefined, platform };
}

/** Applies a platform configured before the first open to replay dispatch. */
export function buildReplayScriptPlatformFlags(
  flags: CommandFlags | undefined,
  actions: SessionAction[],
): CommandFlags {
  const selection = readScriptReplaySelection(actions);
  if (flags?.platform !== undefined || !selection.platform) {
    return flags ?? {};
  }
  return { ...flags, platform: selection.platform };
}

function readMaestroReplayAppTarget(program: MaestroProgram): string | undefined {
  const configured = program.config.appId;
  if (isStaticAppTarget(configured)) return configured;
  const launch = [...(program.config.onFlowStart ?? []), ...program.commands].find(
    (command) => command.kind === 'launchApp' && isStaticAppTarget(command.appId),
  );
  return launch?.kind === 'launchApp' ? launch.appId : undefined;
}

function isStaticAppTarget(value: string | undefined): value is string {
  return Boolean(value && value.trim() && !value.includes('$') && !isDeepLinkTarget(value));
}

function appTargetResolutionOptions(
  openTarget: string | undefined,
): ResolveTargetDeviceOptions | undefined {
  const appTarget = appleSimulatorAppTargetForOpenTarget(openTarget);
  return appTarget ? { appleSimulatorAppTarget: appTarget } : undefined;
}
