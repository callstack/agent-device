import path from 'node:path';
import { workspaceSpecifierTargets } from '../layering/package-boundaries.ts';

export type WorkspaceSourceAlias = {
  find: RegExp;
  replacement: string;
};

function exactSpecifier(specifier: string): RegExp {
  return new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/** Exact exported workspace-package aliases for Vitest inside Stryker's sandbox. */
export function workspaceSourceAliases(repoRoot: string): WorkspaceSourceAlias[] {
  return [...workspaceSpecifierTargets(repoRoot)].map(([specifier, target]) => ({
    find: exactSpecifier(specifier),
    replacement: path.join(repoRoot, target),
  }));
}
