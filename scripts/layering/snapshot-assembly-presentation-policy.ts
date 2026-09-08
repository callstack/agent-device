// Catches: the daemon snapshot assembly presenting an iOS tree a second time, or a producer
//   adapter presenting one at all — the shape #2199 deleted. Before it, `buildSnapshotState`
//   imported the iOS snapshot engine and re-ran semantic compaction whenever a producer-name
//   branch said the engine had not, so an engine-presented Simulator bridge tree was compacted
//   twice (#2188 invariant 2, "geometric presentation occurs exactly once"). Nothing about that
//   regrowth is visible at a call site: the second pass is a legal call to a legal export, and on
//   a tree where compaction happens to be idempotent it produces no test failure at all.
// Evidence: 7ee1a5ded7 (#2233) carried provider acquisitions through one presentation owner and
//   left the bridge behind; d26b0786fb (#2329) put the bridge on the engine without retiring the
//   branch that assumed it was not; #2199 deleted the branch this policy now holds deleted.
// Cost: 292 LOC (147 rule + 145 test).
// Kill criterion: none enforced today; retire only by maintainer decision that the assembly
//   staying presentation-neutral no longer matters. An exports map cannot replace it: the engine
//   subpath is a legitimate public entrypoint for the engine's own callers, so a manifest can only
//   ban it for everyone or no one, and no manifest sees a string literal at all.

import { parseSync } from 'oxc-parser';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';
import { visitAst } from './layering-ast.ts';

export const SNAPSHOT_ASSEMBLY_PRESENTATION_RULE = 'R74 snapshot-assembly-presentation-neutrality';

/**
 * The daemon assembly of a captured tree. It normalizes, prunes, annotates occlusion and attaches
 * refs; it does not present, and it does not know which channel it is holding.
 */
export const SNAPSHOT_ASSEMBLY_FILES: readonly string[] = [
  'packages/capture-kit/src/snapshot-state.ts',
  'src/daemon/snapshot-capture.ts',
];

/** Producer adapters: they report acquisition facts and nothing else. */
export const SNAPSHOT_PRODUCER_ADAPTER_ROOTS: readonly string[] = [
  'packages/platform-apple/src/snapshot-source/',
];

/**
 * iOS presentation. The engine owns projection, geometry, scope, depth, actionability narrowing
 * and semantic compaction; the acquisition module owns the producer capability table that decides
 * them. Reading either one from the assembly or from a producer adapter is how the deleted
 * backend-name policy grows back.
 */
const IOS_PRESENTATION_TARGETS: readonly string[] = [
  'packages/capture-kit/src/ios-snapshot-engine/',
  'packages/capture-kit/src/ios-snapshot-acquisition.ts',
];

/**
 * The iOS channel and its producers. Naming one inside the assembly is a presentation or scope
 * decision by backend name, which #2188 invariant 6 routes through typed capabilities instead.
 */
const IOS_PROVENANCE_LITERALS: ReadonlySet<string> = new Set([
  'xctest',
  'apple-runner',
  'simulator-ax-bridge',
  'appium-source',
  'limrun-ios-tree',
]);

export function snapshotAssemblyPresentationViolations(
  sources: ReadonlyMap<string, string>,
  edges: readonly ResolvedImportEdge[],
): LayeringViolation[] {
  return [
    ...missingOwnerViolations(sources),
    ...importViolations(edges),
    ...provenanceLiteralViolations(sources),
  ];
}

/**
 * A rule that silently checks nothing is worse than no rule. If the assembly moves, this fails
 * rather than passing over an empty file set.
 */
function missingOwnerViolations(sources: ReadonlyMap<string, string>): LayeringViolation[] {
  return SNAPSHOT_ASSEMBLY_FILES.filter((file) => !sources.has(file)).map((file) => ({
    rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
    file,
    line: 1,
    message: `${file} is missing, so the snapshot assembly's presentation neutrality cannot be checked; point SNAPSHOT_ASSEMBLY_FILES at the assembly's new home`,
  }));
}

function importViolations(edges: readonly ResolvedImportEdge[]): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const edge of edges) {
    if (!isIosPresentationTarget(edge.target)) continue;
    if (SNAPSHOT_ASSEMBLY_FILES.includes(edge.file)) {
      violations.push({
        rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
        file: edge.file,
        line: edge.line,
        message: `the daemon snapshot assembly must not import iOS presentation (${edge.target}); an iOS capture is presented once, by the engine, before it reaches the assembly`,
      });
      continue;
    }
    if (isProducerAdapter(edge.file)) {
      violations.push({
        rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
        file: edge.file,
        line: edge.line,
        message: `a producer adapter must not import iOS presentation (${edge.target}); producers report acquisition facts and the engine presents them`,
      });
    }
  }
  return violations;
}

function provenanceLiteralViolations(sources: ReadonlyMap<string, string>): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of SNAPSHOT_ASSEMBLY_FILES) {
    const source = sources.get(file);
    if (source === undefined) continue;
    const program = parseSync(file, source).program;
    visitAst(program, (node) => {
      if (node.type !== 'Literal' || typeof node.value !== 'string') return;
      if (!IOS_PROVENANCE_LITERALS.has(node.value)) return;
      violations.push({
        rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
        file,
        line: sourceLine(source, node.start as number | undefined),
        message: `the daemon snapshot assembly must not branch on the iOS channel or producer name ('${node.value}'); producer differences enter through typed capabilities, read by the engine`,
      });
    });
  }
  return violations;
}

function isIosPresentationTarget(target: string): boolean {
  return IOS_PRESENTATION_TARGETS.some(
    (owner) => target === owner || target.startsWith(owner) || target === owner.replace(/\/$/, ''),
  );
}

function isProducerAdapter(file: string): boolean {
  return SNAPSHOT_PRODUCER_ADAPTER_ROOTS.some((root) => file.startsWith(root));
}

function sourceLine(source: string, offset: number | undefined): number {
  return source.slice(0, typeof offset === 'number' ? offset : 0).split('\n').length;
}
