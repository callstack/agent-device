import { AppError } from '@agent-device/kernel/errors';

export type AppsFilter = 'user-installed' | 'all';

// Provider runtimes call `resolveAppsFilter` with an optional filter that never passed through the
// command registry, so they need a fallback of their own. The command default itself lives in the
// command registry's `COMMAND_DEFAULTS`, applied by the CLI parser and the daemon alike.
const DEFAULT_APPS_FILTER: AppsFilter = 'user-installed';

export function resolveAppsFilter(value: AppsFilter | undefined): AppsFilter {
  return value ?? DEFAULT_APPS_FILTER;
}

export function assertResolvedAppsFilter(value: AppsFilter | undefined): AppsFilter {
  if (value === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'appsFilter must be resolved before executing the apps command',
    );
  }
  return value;
}
