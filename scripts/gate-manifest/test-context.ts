// Shared fixture scaffolding for the gate-manifest tests.
//
// Almost every case here is synthetic on purpose: the point of this gate is to catch shapes
// that do NOT exist in the repo yet — a renamed CI job, a deleted intermediate script, a new
// Vitest project nobody wired, a workflow trigger that excludes the paths its own gate owns. A
// test that could only assert today's tree would go green the moment the tree grew the hole.

import { buildLanes, parseWorkflow, type Lane } from './workflow-lanes.ts';
import type { ResolveContext } from './execution-terminals.ts';

export function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    packageScripts: new Map(),
    actions: new Map(),
    vitestProjects: ['unit-core', 'subprocess-stub'],
    expandTestPaths: (pattern) => [pattern],
    transparentWrappers: new Set(),
    declaredTerminals: new Map(),
    gateRunners: new Set(),
    ...overrides,
  };
}

export function lanesFor(workflows: Record<string, string>, ctx: ResolveContext): Lane[] {
  return buildLanes(
    Object.entries(workflows).map(([file, source]) => parseWorkflow(file, source)),
    ctx,
  );
}
