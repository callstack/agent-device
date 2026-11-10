import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import {
  INTERACTION_DISPATCH_PATHS,
  INTERACTION_GUARANTEES,
  INTERACTION_PATH_IDS,
} from '@agent-device/contracts/interaction-guarantees';
import { CONTRACT_COVERAGE } from '../../../test/integration/interaction-contract/index.ts';

// ADR 0011 Layer-3 root gate: the contract scenario suite is registry-driven. Every
// matrix cell that claims enforcement (runtime, runner, or delegated) must be
// proven by at least one scenario in test/integration/interaction-contract/,
// and no scenario may claim a waived or inapplicable cell — coverage of the
// matrix is by construction, not reviewer memory, in both directions.

const ENFORCED_KINDS: ReadonlySet<string> = new Set(['runtime', 'runner', 'delegated']);

function cellKey(pathId: string, guarantee: string): string {
  return `${pathId}/${guarantee}`;
}

test('contract coverage entries reference real matrix cells and named scenarios', () => {
  for (const entry of CONTRACT_COVERAGE) {
    assert.ok(
      (INTERACTION_PATH_IDS as readonly string[]).includes(entry.path),
      `coverage entry references unknown path "${entry.path}"`,
    );
    assert.ok(
      (INTERACTION_GUARANTEES as readonly string[]).includes(entry.guarantee),
      `coverage entry references unknown guarantee "${entry.guarantee}"`,
    );
    assert.ok(
      entry.scenario.trim().length > 10,
      `${cellKey(entry.path, entry.guarantee)}: scenario name must describe what it proves`,
    );
  }
});

test('contract coverage never claims a waived or inapplicable cell', () => {
  for (const entry of CONTRACT_COVERAGE) {
    const enforcement = INTERACTION_DISPATCH_PATHS[entry.path].guarantees[entry.guarantee];
    // Overclaiming is an error too: a scenario tagged onto a waived cell would
    // make the debt list look repaid without flipping the matrix cell.
    assert.ok(
      ENFORCED_KINDS.has(enforcement.kind),
      `${cellKey(entry.path, entry.guarantee)} is "${enforcement.kind}" — drop the coverage entry or flip the matrix cell in the same PR`,
    );
  }
});

test('every enforced matrix cell has at least one contract scenario', () => {
  const covered = new Set(CONTRACT_COVERAGE.map((entry) => cellKey(entry.path, entry.guarantee)));
  const missing: string[] = [];
  for (const pathId of INTERACTION_PATH_IDS) {
    for (const guarantee of INTERACTION_GUARANTEES) {
      const enforcement = INTERACTION_DISPATCH_PATHS[pathId].guarantees[guarantee];
      if (!ENFORCED_KINDS.has(enforcement.kind)) continue;
      if (!covered.has(cellKey(pathId, guarantee))) missing.push(cellKey(pathId, guarantee));
    }
  }
  assert.deepEqual(
    missing,
    [],
    'enforced matrix cells without a contract scenario — add one under test/integration/interaction-contract/ and register its manifest in index.ts',
  );
});

const CONTRACT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../test/integration/interaction-contract',
);

type AstNode = { type: string; [key: string]: unknown };

function programBody(fileName: string): AstNode[] {
  const source = fs.readFileSync(path.join(CONTRACT_DIR, fileName), 'utf8');
  const parsed = parseSync(fileName, source);
  assert.deepEqual(parsed.errors, [], `${fileName} does not parse`);
  return parsed.program.body as unknown as AstNode[];
}

function identifierName(node: unknown): string | undefined {
  const candidate = node as AstNode | undefined;
  return candidate?.type === 'Identifier' ? (candidate.name as string) : undefined;
}

/** The names a file exports as `export const <name> = ...`. */
function exportedConstNames(body: AstNode[]): string[] {
  return body.flatMap((node) => {
    const declaration = node.declaration as AstNode | null | undefined;
    if (node.type !== 'ExportNamedDeclaration' || declaration?.type !== 'VariableDeclaration') {
      return [];
    }
    return (declaration.declarations as AstNode[]).flatMap((declarator) => {
      const name = identifierName(declarator.id);
      return name ? [name] : [];
    });
  });
}

/** The local binding of `imported` from `source`, if the file imports it. */
function importedLocalName(body: AstNode[], source: string, imported: string): string | undefined {
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue;
    if ((node.source as { value: string }).value !== source) continue;
    for (const specifier of node.specifiers as AstNode[]) {
      if (specifier.type === 'ImportSpecifier' && identifierName(specifier.imported) === imported) {
        return identifierName(specifier.local);
      }
    }
  }
  return undefined;
}

function hasTopLevelCall(body: AstNode[], callee: string, argument: string): boolean {
  return body.some((node) => {
    const call = node.expression as AstNode | undefined;
    if (node.type !== 'ExpressionStatement' || call?.type !== 'CallExpression') return false;
    const args = call.arguments as unknown[];
    return (
      identifierName(call.callee) === callee &&
      args.length === 1 &&
      identifierName(args[0]) === argument
    );
  });
}

test('every coverage manifest has a contract file that checks its claims are registered', () => {
  const manifests = fs.readdirSync(CONTRACT_DIR).filter((name) => name.endsWith('.coverage.ts'));
  assert.ok(manifests.length > 0, 'no coverage manifests found');
  for (const manifest of manifests) {
    const contractFile = manifest.replace(/\.coverage\.ts$/, '.contract.test.ts');
    assert.ok(
      fs.existsSync(path.join(CONTRACT_DIR, contractFile)),
      `${manifest} has no sibling ${contractFile}`,
    );
    const [coverageName, ...extra] = exportedConstNames(programBody(manifest));
    assert.ok(coverageName && extra.length === 0, `${manifest} must export exactly one manifest`);
    const body = programBody(contractFile);
    const coverage = importedLocalName(body, `./${manifest}`, coverageName);
    const register = importedLocalName(
      body,
      './coverage-registration.ts',
      'assertCoverageClaimsRegistered',
    );
    assert.ok(
      coverage && register && hasTopLevelCall(body, register, coverage),
      `${contractFile} must import ${coverageName} from ./${manifest} and call ` +
        `assertCoverageClaimsRegistered(${coverageName}) at top level`,
    );
  }
});
