import { AppError } from '../kernel/errors.ts';

export type AppsFilter = 'user-installed' | 'all';

export const DEFAULT_APPS_FILTER: AppsFilter = 'user-installed';

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
