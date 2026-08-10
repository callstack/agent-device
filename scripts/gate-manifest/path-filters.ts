// GitHub workflow path-filter semantics.
//
// Kept apart from the lane model because this is the half that answers "would a PR touching
// only this file start this workflow at all?" — the question behind the #1420 hole, where a
// gate exists, its job exists, and the job never fires for the change it is meant to gate.

import type { WorkflowTriggers } from './workflow-lanes.ts';

/** GitHub workflow path filter → RegExp. `**` crosses `/`, `*` and `?` do not. */
export function pathFilterMatches(pattern: string, file: string): boolean {
  const source = pattern.split('').reduce<{ out: string; index: number }>(
    (state, _char, index, chars) => {
      if (index < state.index) return state;
      const rest = chars.slice(index).join('');
      if (rest.startsWith('**/')) return { out: `${state.out}(?:.*/)?`, index: index + 3 };
      if (rest.startsWith('**')) return { out: `${state.out}.*`, index: index + 2 };
      const char = chars[index]!;
      if (char === '*') return { out: `${state.out}[^/]*`, index: index + 1 };
      if (char === '?') return { out: `${state.out}[^/]`, index: index + 1 };
      return { out: state.out + char.replace(/[.+^${}()|[\]\\]/g, '\\$&'), index: index + 1 };
    },
    { out: '', index: 0 },
  ).out;
  return new RegExp(`^${source}$`).test(file);
}

/** Whether a PR touching only `file` would trigger this workflow. */
export function triggersOnPath(triggers: WorkflowTriggers, file: string): boolean {
  if (!triggers.events.includes('pull_request')) return false;
  if (triggers.pullRequestPathsIgnore?.some((pattern) => pathFilterMatches(pattern, file))) {
    return false;
  }
  if (triggers.pullRequestPaths) {
    return triggers.pullRequestPaths.some((pattern) => pathFilterMatches(pattern, file));
  }
  return true;
}
