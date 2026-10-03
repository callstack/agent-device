import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { SessionAction } from '@agent-device/contracts/session';
import type { ConvertedAction, MaestroExportCommand } from './export-types.ts';

export const NAVIGATION_ACTION_CONVERTERS: Record<
  'open' | 'back' | 'home' | 'keyboard',
  (action: SessionAction) => ConvertedAction
> = {
  open: convertOpenAction,
  back: () => ({ kind: 'commands', commands: ['back'] }),
  home: () => ({ kind: 'commands', commands: [{ pressKey: 'Home' }] }),
  keyboard: convertKeyboardAction,
};

function convertOpenAction(action: SessionAction): ConvertedAction {
  const [first, second] = action.positionals;
  if (!first) return { kind: 'unsupported', message: 'open requires an app id or URL' };

  if (isDeepLinkTarget(first)) {
    return { kind: 'commands', commands: [{ openLink: first }] };
  }

  const launchApp = buildLaunchAppCommand(action, first);
  if (second && isDeepLinkTarget(second)) {
    return { kind: 'config', appId: first, commands: [launchApp, { openLink: second }] };
  }
  if (second) {
    return { kind: 'unsupported', message: 'open with a non-URL second argument is unsupported' };
  }
  return { kind: 'config', appId: first, commands: [launchApp] };
}

function buildLaunchAppCommand(action: SessionAction, appId: string): MaestroExportCommand {
  return { launchApp: { appId, ...buildLaunchAppOptions(action) } };
}

function buildLaunchAppOptions(action: SessionAction): Record<string, unknown> {
  const launchArgs = action.flags?.launchArgs;
  const options: Record<string, unknown> = {};
  if (action.flags?.relaunch === true) options.stopApp = true;
  if (action.flags?.clearAppState === true) options.clearState = true;
  if (Array.isArray(launchArgs) && launchArgs.length > 0) {
    options.launchArguments = launchArgs;
  }
  return options;
}

function convertKeyboardAction(action: SessionAction): ConvertedAction {
  const [subcommand] = action.positionals;
  if (subcommand === 'dismiss') return { kind: 'commands', commands: ['hideKeyboard'] };
  if (subcommand === 'enter' || subcommand === 'return') {
    return { kind: 'commands', commands: [{ pressKey: 'Enter' }] };
  }
  return { kind: 'unsupported', message: `keyboard ${subcommand ?? ''}`.trim() };
}
