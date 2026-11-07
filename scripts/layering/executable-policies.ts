import { ARCHITECTURE_OWNERSHIP, matchesDeclaredRoot } from './architecture-ownership.ts';
import { resolveImportEdges } from './model.ts';

type ExecutablePolicyName = (typeof ARCHITECTURE_OWNERSHIP.executablePolicies)[number]['name'];

/**
 * Evaluates every `executablePolicies` declaration against one import graph. Each entry lists the
 * edges that run from the policy's roots into one of its forbidden target roots, as
 * `file:line -> target`.
 */
export function executablePolicyViolations(
  sources: ReadonlyMap<string, string>,
  workspaceTargets?: ReadonlyMap<string, string>,
): Record<ExecutablePolicyName, string[]> {
  const edges = resolveImportEdges(sources, workspaceTargets);
  return Object.fromEntries(
    ARCHITECTURE_OWNERSHIP.executablePolicies.map((policy) => [
      policy.name,
      edges
        .filter(
          (edge) =>
            policy.roots.some((root) => matchesDeclaredRoot(edge.file, root)) &&
            policy.forbiddenTargetRoots.some((root) => matchesDeclaredRoot(edge.target, root)),
        )
        .map((edge) => `${edge.file}:${edge.line} -> ${edge.target}`),
    ]),
  ) as Record<ExecutablePolicyName, string[]>;
}
