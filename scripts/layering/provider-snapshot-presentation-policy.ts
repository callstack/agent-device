// Catches: a provider-* package acquiring an iOS snapshot outside the capture-kit acquisition
//   entrypoint, or presenting it outside src/snapshot/ios-snapshot-runtime.ts — the exact split
//   R72's engine convergence closed for the runner layer, mirrored here one layer up for the
//   provider packages that call into it.
// Evidence: 7ee1a5ded7 (#2233) carried provider acquisitions through this one presentation
//   owner, the change this policy was written to hold in place.
// Cost: 195 LOC (111 rule + 84 test).
// Kill criterion: none enforced today; retire only by maintainer decision that provider-* packages
//   reaching presentation only through @agent-device/capture-kit/ios-snapshot-acquisition, and
//   never constructing, discarding, or reassigning acquisition residue, no longer matter. An
//   exports map cannot replace it: it restricts external specifiers, not the transitive walk
//   into src/snapshot/ or a provider-local `residue` property or assignment.

import { parseSync } from 'oxc-parser';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';
import { memberPath, propertyName, visitAst } from './layering-ast.ts';

export const PROVIDER_SNAPSHOT_PRESENTATION_RULE = 'R73 provider-snapshot-presentation-ownership';
export const IOS_SNAPSHOT_ACQUISITION_ENTRYPOINT =
  '@agent-device/capture-kit/ios-snapshot-acquisition';
export const IOS_SNAPSHOT_PRESENTATION_OWNER = 'src/snapshot/ios-snapshot-runtime.ts';

const PROVIDER_SOURCE = /^packages\/provider-[^/]+\/src\//;
const IOS_SNAPSHOT_CAPTURE_KIT_ROOT = 'packages/capture-kit/src/ios-snapshot-';

type AstNode = Record<string, unknown>;

export function providerSnapshotPresentationViolations(
  sources: ReadonlyMap<string, string>,
  edges: readonly ResolvedImportEdge[],
): LayeringViolation[] {
  const edgesByFile = new Map<string, ResolvedImportEdge[]>();
  for (const edge of edges) {
    const fileEdges = edgesByFile.get(edge.file) ?? [];
    fileEdges.push(edge);
    edgesByFile.set(edge.file, fileEdges);
  }

  const violations: LayeringViolation[] = [];
  for (const file of sources.keys()) {
    if (!PROVIDER_SOURCE.test(file)) continue;
    violations.push(...presentationImportViolations(file, edgesByFile));
    violations.push(...residueViolations(file, sources.get(file)!));
  }
  return violations;
}

function presentationImportViolations(
  providerFile: string,
  edgesByFile: ReadonlyMap<string, readonly ResolvedImportEdge[]>,
): LayeringViolation[] {
  const origins = new Map<string, ResolvedImportEdge>();
  const visited = new Set([providerFile]);
  const queue = [providerFile];
  const violations: LayeringViolation[] = [];

  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const edge of edgesByFile.get(file) ?? []) {
      const origin = origins.get(file) ?? edge;
      if (isPresentationTarget(edge.target)) {
        violations.push(
          violation(
            providerFile,
            origin.line,
            `provider package reaches ${edge.target} before host owner ${IOS_SNAPSHOT_PRESENTATION_OWNER}; use ${IOS_SNAPSHOT_ACQUISITION_ENTRYPOINT} for acquisition`,
          ),
        );
        continue;
      }
      if (visited.has(edge.target)) continue;
      visited.add(edge.target);
      origins.set(edge.target, origin);
      queue.push(edge.target);
    }
  }
  return violations;
}

function residueViolations(providerFile: string, source: string): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  const program = parseSync(providerFile, source).program;
  visitAst(program, (node) => {
    if (node.type === 'Property' && propertyName(node.key) === 'residue') {
      violations.push(
        violation(
          providerFile,
          sourceLine(source, node.start as number | undefined),
          'provider package must not construct or discard acquisition residue; the acquisition entrypoint owns it',
        ),
      );
    }
    if (
      node.type === 'AssignmentExpression' &&
      memberPath(node.left as AstNode | undefined)?.includes('residue')
    ) {
      violations.push(
        violation(
          providerFile,
          sourceLine(source, node.start as number | undefined),
          'provider package must not rewrite acquisition residue; the acquisition entrypoint owns it',
        ),
      );
    }
  });
  return violations;
}

function isPresentationTarget(target: string): boolean {
  return (
    target === IOS_SNAPSHOT_PRESENTATION_OWNER ||
    target.startsWith('src/snapshot/') ||
    (target.startsWith(IOS_SNAPSHOT_CAPTURE_KIT_ROOT) &&
      target !== 'packages/capture-kit/src/ios-snapshot-acquisition.ts')
  );
}

function sourceLine(source: string, offset: number | undefined): number {
  return source.slice(0, typeof offset === 'number' ? offset : 0).split('\n').length;
}

function violation(file: string, line: number, message: string): LayeringViolation {
  return { rule: PROVIDER_SNAPSHOT_PRESENTATION_RULE, file, line, message };
}
