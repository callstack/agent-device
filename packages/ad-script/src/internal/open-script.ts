import type { SessionAction } from '@agent-device/contracts/session';
import {
  appendRuntimeHintFlags,
  formatScriptArg,
  parseReplayRuntimeFlags,
} from './script-utils.ts';

/**
 * #1555 structural-quality review ("declaredScriptPlatform... move to
 * packages/ad-script, its natural owner"): the platform a script declares
 * before its first real `open` — `runtime` actions accumulate a platform,
 * and the first `open` action's own attached `runtime.platform` wins over
 * (or falls back to) that accumulation. Two independent daemon/package call
 * sites needed exactly this scan and, before this move, each carried its own
 * copy: `packages/ad-replay/src/internal/inspect.ts`'s plan-digest platform
 * precedence, and `src/daemon/replay-device-selection.ts`'s
 * `readScriptReplaySelection` (fused into its own single pass alongside an
 * app-target scan). A `src/` root file cannot become a façade dependency
 * (R11), and a workspace package may not reach back into root `src/` either
 * — `ad-script` is the one package both `ad-replay` and the daemon already
 * depend on, so it is the correct single owner. Both call sites now import
 * this function instead of maintaining their own copy.
 */
export function resolveDeclaredScriptPlatform(
  actions: readonly SessionAction[],
): string | undefined {
  let platform: string | undefined;
  for (const action of actions) {
    if (action.command === 'runtime' && typeof action.flags.platform === 'string') {
      platform = action.flags.platform;
      continue;
    }
    if (action.command !== 'open') continue;
    return action.runtime?.platform ?? platform;
  }
  return platform;
}

export function appendOpenActionScriptArgs(
  parts: string[],
  action: Pick<SessionAction, 'positionals' | 'flags' | 'runtime'>,
): void {
  for (const positional of action.positionals ?? []) {
    parts.push(formatScriptArg(positional));
  }
  if (action.flags?.relaunch) {
    parts.push('--relaunch');
  }
  appendRuntimeHintFlags(parts, action.runtime);
}

export function parseReplayOpenFlags(args: string[]): {
  positionals: string[];
  flags: SessionAction['flags'];
  runtime?: SessionAction['runtime'];
} {
  const argsWithoutRelaunch: string[] = [];
  const flags: SessionAction['flags'] = {};
  for (const token of args) {
    if (token === '--relaunch') {
      flags.relaunch = true;
      continue;
    }
    argsWithoutRelaunch.push(token);
  }
  const parsedRuntime = parseReplayRuntimeFlags(argsWithoutRelaunch);
  return {
    positionals: parsedRuntime.positionals,
    flags,
    runtime: hasReplayOpenRuntimeHints(parsedRuntime.flags) ? parsedRuntime.flags : undefined,
  };
}

function hasReplayOpenRuntimeHints(
  flags: ReturnType<typeof parseReplayRuntimeFlags>['flags'],
): boolean {
  return Boolean(
    flags.platform ||
    flags.metroHost ||
    flags.metroPort !== undefined ||
    flags.bundleUrl ||
    flags.launchUrl,
  );
}
