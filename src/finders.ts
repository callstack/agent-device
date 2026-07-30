export { parseFindArgs } from './selectors/find.ts';

import {
  findBestMatchesByLocator as findBestMatchesByLocatorInternal,
  type FindLocator,
} from './selectors/find.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

export type FindMatchOptions = {
  requireRect?: boolean;
};

export function findBestMatchesByLocator(
  nodes: SnapshotNode[],
  locator: FindLocator,
  query: string,
  options?: boolean | FindMatchOptions,
) {
  const matchOptions = typeof options === 'boolean' ? { requireRect: options } : options;
  return findBestMatchesByLocatorInternal(nodes, locator, query, matchOptions);
}
