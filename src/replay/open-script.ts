import type { SessionAction } from '../contracts/session-action.ts';
import {
  appendRuntimeHintFlags,
  formatScriptArg,
  parseReplayRuntimeFlags,
} from './script-utils.ts';

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
