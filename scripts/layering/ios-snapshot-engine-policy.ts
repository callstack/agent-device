// Catches: an iOS snapshot caller reaching the XCTest/Limrun/Appium runners directly instead of
//   through the one converged engine.ts — the fragmentation #2222's "converge Limrun snapshots
//   through engine" and #758's "bulk-snapshot DEPTH limit" both trace back to, where each
//   backend's snapshot path could silently diverge from the others' presentation contract.
// Evidence: a8ee397168 (#2213) added the snapshot engine conformance gates this policy
//   enforces; 6c8c0508d9 (#2222) converged Limrun snapshots through the engine it protects.
// Cost: 267 LOC (229 rule + 38 test).
// Kill criterion: none enforced today; retire only by maintainer decision that the engine.ts →
//   runner-presentation.ts call topology (presentIosSnapshot and publishIosSnapshot each make
//   their one delegating call; the runner file never folds, validates, or builds the
//   presentation itself) no longer matters. An exports map cannot replace it: both files sit
//   in one package and call each other by relative import, which no manifest restricts.

import { parseSync } from 'oxc-parser';
import type { LayeringViolation } from './model.ts';
import { memberPath, visitAst } from './layering-ast.ts';

export const IOS_SNAPSHOT_ENGINE_OWNERSHIP_RULE = 'R72 ios-snapshot-engine-ownership';
export const IOS_SNAPSHOT_ENGINE_FILE = 'packages/capture-kit/src/ios-snapshot-engine/engine.ts';
export const IOS_SNAPSHOT_RUNNER_FILE =
  'packages/capture-kit/src/ios-snapshot-engine/runner-presentation.ts';

type SourceFile = Readonly<{ path: string; source: string }>;
type AstNode = Record<string, unknown>;
type CallSite = Readonly<{ line: number; arguments: readonly AstNode[] }>;

export function iosSnapshotEngineOwnershipViolations(
  sources: readonly SourceFile[],
): LayeringViolation[] {
  const byPath = new Map(sources.map((file) => [file.path, file.source]));
  const engineSource = byPath.get(IOS_SNAPSHOT_ENGINE_FILE);
  const runnerSource = byPath.get(IOS_SNAPSHOT_RUNNER_FILE);
  const violations: LayeringViolation[] = [];
  if (!engineSource) violations.push(missingFile(IOS_SNAPSHOT_ENGINE_FILE));
  if (!runnerSource) violations.push(missingFile(IOS_SNAPSHOT_RUNNER_FILE));
  if (!engineSource || !runnerSource) return violations;

  const engine = parseSource(IOS_SNAPSHOT_ENGINE_FILE, engineSource);
  const runner = parseSource(IOS_SNAPSHOT_RUNNER_FILE, runnerSource);
  const present = functionBody(engine, 'presentIosSnapshot');
  const publish = functionBody(engine, 'publishIosSnapshot');
  const acquired = functionBody(engine, 'presentAcquiredSnapshot');
  const presented = functionBody(runner, 'presentIosRunnerSnapshot');
  const runnerPayloads = functionBody(runner, 'validateRunnerPayloads');
  const runnerCompaction = functionBody(runner, 'compactRunnerPayload');

  requireCallCount(
    violations,
    IOS_SNAPSHOT_ENGINE_FILE,
    'presentIosSnapshot',
    present,
    'presentAcquiredSnapshot',
    1,
  );
  requireCallCount(
    violations,
    IOS_SNAPSHOT_ENGINE_FILE,
    'presentIosSnapshot',
    present,
    'presentIosRunnerSnapshot',
    1,
  );
  requireCallCount(
    violations,
    IOS_SNAPSHOT_ENGINE_FILE,
    'publishIosSnapshot',
    publish,
    'presentIosSnapshot',
    1,
  );
  requireCallCount(
    violations,
    IOS_SNAPSHOT_ENGINE_FILE,
    'presentAcquiredSnapshot',
    acquired,
    'buildIosInteractiveSnapshotPresentation',
    1,
  );
  requireCallCount(
    violations,
    IOS_SNAPSHOT_RUNNER_FILE,
    'presentIosRunnerSnapshot',
    presented,
    'validateRunnerPayloads',
    1,
  );
  requireCallCount(
    violations,
    IOS_SNAPSHOT_RUNNER_FILE,
    'presentIosRunnerSnapshot',
    presented,
    'compactRunnerPayload',
    1,
  );
  requireCallCount(
    violations,
    IOS_SNAPSHOT_RUNNER_FILE,
    'presentIosRunnerSnapshot',
    presented,
    'foldIosSnapshot',
    0,
  );
  requireCallCount(
    violations,
    IOS_SNAPSHOT_RUNNER_FILE,
    'presentIosRunnerSnapshot',
    presented,
    'validateIosPayload',
    0,
  );
  requireCallCount(
    violations,
    IOS_SNAPSHOT_RUNNER_FILE,
    'presentIosRunnerSnapshot',
    presented,
    'buildIosInteractiveSnapshotPresentation',
    0,
  );
  requireCallCount(
    violations,
    IOS_SNAPSHOT_RUNNER_FILE,
    'validateRunnerPayloads',
    runnerPayloads,
    'validateIosPayload',
    2,
  );
  requireArgumentPath(
    violations,
    IOS_SNAPSHOT_RUNNER_FILE,
    'validateRunnerPayloads',
    runnerPayloads,
    'validateIosPayload',
    ['input', 'presentation', 'payload', 'nodes'],
  );
  requireArgumentPath(
    violations,
    IOS_SNAPSHOT_RUNNER_FILE,
    'validateRunnerPayloads',
    runnerPayloads,
    'validateIosPayload',
    ['input', 'presentation', 'qualityPayload', 'nodes'],
  );
  requireCallCount(
    violations,
    IOS_SNAPSHOT_RUNNER_FILE,
    'compactRunnerPayload',
    runnerCompaction,
    'buildIosInteractiveSnapshotPresentation',
    1,
  );
  return violations;
}

function missingFile(file: string): LayeringViolation {
  return {
    rule: IOS_SNAPSHOT_ENGINE_OWNERSHIP_RULE,
    file,
    line: 1,
    message: `${file} is missing, so the iOS snapshot engine ownership paths cannot be checked`,
  };
}

function parseSource(file: string, source: string): AstNode {
  return parseSync(file, source).program as unknown as AstNode;
}

function functionBody(program: AstNode, name: string): AstNode | undefined {
  let body: AstNode | undefined;
  visitAst(program, (node) => {
    if (body || node.type !== 'FunctionDeclaration') return;
    const id = node.id as AstNode | undefined;
    if (id?.type !== 'Identifier' || id.name !== name) return;
    body = node.body as AstNode | undefined;
  });
  return body;
}

function callSites(body: AstNode | undefined, name: string): CallSite[] {
  if (!body) return [];
  const sites: CallSite[] = [];
  visitAst(body, (node) => {
    if (node.type !== 'CallExpression' || identifierName(node.callee) !== name) return;
    sites.push({
      line: 1,
      arguments: (node.arguments as AstNode[] | undefined) ?? [],
    });
  });
  return sites;
}

function identifierName(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const record = node as AstNode;
  return record.type === 'Identifier' && typeof record.name === 'string' ? record.name : undefined;
}

function requireCallCount(
  violations: LayeringViolation[],
  file: string,
  functionName: string,
  body: AstNode | undefined,
  callName: string,
  expected: number,
): void {
  const sites = callSites(body, callName);
  if (sites.length === expected) return;
  violations.push({
    rule: IOS_SNAPSHOT_ENGINE_OWNERSHIP_RULE,
    file,
    line: sites[0]?.line ?? 1,
    message:
      `${functionName} must call ${callName} exactly ${String(expected)} time(s); found ` +
      String(sites.length),
  });
}

function requireArgumentPath(
  violations: LayeringViolation[],
  file: string,
  functionName: string,
  body: AstNode | undefined,
  callName: string,
  expectedPath: readonly string[],
): void {
  const sites = callSites(body, callName);
  if (sites.some((site) => site.arguments.some((argument) => samePath(argument, expectedPath)))) {
    return;
  }
  violations.push({
    rule: IOS_SNAPSHOT_ENGINE_OWNERSHIP_RULE,
    file,
    line: sites[0]?.line ?? 1,
    message: `${functionName} must validate ${expectedPath.join('.')}`,
  });
}

function samePath(node: AstNode, expected: readonly string[]): boolean {
  const actual = memberPath(node);
  return (
    actual?.length === expected.length && actual.every((part, index) => part === expected[index])
  );
}
