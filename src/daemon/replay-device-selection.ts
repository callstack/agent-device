import fs from 'node:fs';
import { parseReplayInput } from '../compat/replay-input.ts';
import { parseMaestroProgram } from '../compat/maestro/program-ir-parser.ts';
import type { ResolveTargetDeviceOptions } from '../core/dispatch-resolve.ts';
import type { MaestroProgram } from '../compat/maestro/program-ir.ts';
import { SessionStore } from './session-store.ts';
import type { DaemonRequest, SessionAction } from './types.ts';

/**
 * Finds the first static app target a fresh replay will open.  Request binding
 * uses this before any replay action can cache an unqualified device choice.
 */
export function buildReplayTargetDeviceResolutionOptions(
  req: DaemonRequest,
): ResolveTargetDeviceOptions | undefined {
  if (req.command !== 'replay' || req.flags?.replayFrom !== undefined) return undefined;
  const filePath = req.positionals?.[0];
  if (!filePath) return undefined;

  try {
    const resolved = SessionStore.expandHome(filePath, req.meta?.cwd);
    const source = fs.readFileSync(resolved, 'utf8');
    const appTarget = isMaestroReplay(req, resolved)
      ? readMaestroReplayAppTarget(parseMaestroProgram(source, { sourcePath: resolved }))
      : readScriptReplayAppTarget(parseReplayInput(source, req.flags).actions);
    return appTarget ? { appleSimulatorAppTarget: appTarget } : undefined;
  } catch {
    // Parsing and validation stay in the replay handler. Lock binding is only
    // advisory, so an unreadable/invalid plan must not mask its real error.
    return undefined;
  }
}

export function buildMaestroReplayTargetDeviceResolutionOptions(
  program: MaestroProgram,
): ResolveTargetDeviceOptions {
  const appTarget = readMaestroReplayAppTarget(program);
  return appTarget ? { appleSimulatorAppTarget: appTarget } : {};
}

function isMaestroReplay(req: DaemonRequest, filePath: string): boolean {
  return (
    req.flags?.replayBackend === 'maestro' &&
    (filePath.endsWith('.yaml') || filePath.endsWith('.yml'))
  );
}

function readScriptReplayAppTarget(actions: SessionAction[]): string | undefined {
  const target = actions.find((action) => action.command === 'open')?.positionals?.[0];
  return isStaticAppTarget(target) ? target : undefined;
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
  return Boolean(value && value.trim() && !value.includes('$'));
}
