import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');

const BYTE_BUDGETS = {
  'AGENTS.md': 10_000,
  'CONTEXT.md': 12_000,
} as const;
const FOCUSED_DOC_BUDGET = 10_000;
const AGENT_DOCS_TOTAL_BUDGET = 40_000;

async function read(relativePath: string): Promise<string> {
  return readFile(path.join(ROOT, relativePath), 'utf8');
}

test('high-traffic guidance stays within its reviewed context budget', async () => {
  for (const [relativePath, budget] of Object.entries(BYTE_BUDGETS)) {
    const bytes = Buffer.byteLength(await read(relativePath));
    assert.ok(
      bytes <= budget,
      `${relativePath} is ${bytes} bytes; keep it at or below ${budget} by routing details to their owner`,
    );
  }
});

test('task guidance stays focused instead of growing another handbook', async () => {
  const directory = path.join(ROOT, 'docs', 'agents');
  const files = (await readdir(directory, { recursive: true })).filter((file) =>
    file.endsWith('.md'),
  );
  let totalBytes = 0;

  for (const file of files) {
    const bytes = Buffer.byteLength(await read(path.join('docs', 'agents', file)));
    totalBytes += bytes;
    assert.ok(
      bytes <= FOCUSED_DOC_BUDGET,
      `docs/agents/${file} is ${bytes} bytes; split it by contributor question or delete derived/history prose`,
    );
  }

  assert.ok(
    totalBytes <= AGENT_DOCS_TOTAL_BUDGET,
    `docs/agents is ${totalBytes} bytes; keep it at or below ${AGENT_DOCS_TOTAL_BUDGET} by deleting duplication before adding guidance`,
  );
});

test('CONTEXT.md remains a glossary rather than an architecture or workflow document', async () => {
  const content = await read('CONTEXT.md');
  const levelTwoHeadings = [...content.matchAll(/^## (.+)$/gm)].map((match) => match[1]);

  assert.deepEqual(levelTwoHeadings, ['Language']);
  assert.doesNotMatch(content, /(?:^|\s)(?:docs|packages|scripts|src|test)\//);
});

test('the AGENTS.md task router points only at files that exist', async () => {
  const content = await read('AGENTS.md');
  const table = content.match(/\| When the task involves \| Read \|([\s\S]*?)\n\n/)?.[1];
  assert.ok(table, 'AGENTS.md must retain its task-routing table');

  const routedPaths = [...table.matchAll(/`([^`]+\.md)`/g)].map((match) => match[1]);
  assert.ok(routedPaths.length > 0, 'task-routing table must name at least one owned document');

  const rootEntries = new Set(await readdir(ROOT));
  for (const relativePath of routedPaths) {
    const [firstSegment] = relativePath.split('/');
    assert.ok(rootEntries.has(firstSegment), `routed path does not exist: ${relativePath}`);
    await assert.doesNotReject(read(relativePath), `routed path does not exist: ${relativePath}`);
  }
});
