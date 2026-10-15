import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import path from 'node:path';
import { test } from 'node:test';
import { parseSync } from 'oxc-parser';
import { shardFiles } from './sharding.ts';

test('type-only syntax cannot outweigh regex mutations when packing shards', async () => {
  const root = fs.realpathSync(mkdtempForTestSync('mutation-regex-density-'));
  try {
    fs.writeFileSync(
      path.join(root, 'types.ts'),
      `export type Fields = {\n${Array.from({ length: 500 }, (_, index) => `  key${index}: 'value${index}';\n`).join('')}};\n`,
    );
    fs.writeFileSync(
      path.join(root, 'patterns.ts'),
      'export const first = /^(a|b)?[0-9]+$/;\nexport const second = /^(c|d)?[a-z]+$/;\n',
    );
    for (const index of [1, 2]) {
      const selected = await shardFiles(['types.ts', 'patterns.ts'], { index, count: 2 }, root);
      assert.ok(selected.some((range) => range.startsWith('patterns.ts:')));
      assert.ok(selected.every((range) => !range.startsWith('types.ts')));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('compact decisions are spread across shards instead of outweighed by comments', async () => {
  const root = fs.realpathSync(mkdtempForTestSync('mutation-density-'));
  try {
    fs.writeFileSync(
      path.join(root, 'verbose.ts'),
      `${'// long explanation\n'.repeat(500)}export const fallback = false;\n`,
    );
    fs.writeFileSync(
      path.join(root, 'dense.ts'),
      Array.from(
        { length: 8 },
        (_, index) =>
          `export function f${index}(x: number) { return x > 0 && x < 10 ? x + 1 : x - 1; }\n`,
      ).join(''),
    );
    for (const index of [1, 2]) {
      assert.ok(
        (await shardFiles(['verbose.ts', 'dense.ts'], { index, count: 2 }, root)).some((range) =>
          range.startsWith('dense.ts:'),
        ),
        `shard ${index} has no compact decisions`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a single-file kernel is split without losing or duplicating statement-spanning mutants', async () => {
  const root = fs.realpathSync(mkdtempForTestSync('mutation-sharding-'));
  const source = `export const label = "🧪";\nexport function first() {\n${Array.from({ length: 15 }, (_, index) => `  const a${index} = 1;\n`).join('')}  return true;\n}\nexport const second = false;\nexport function third() {\n${Array.from({ length: 15 }, (_, index) => `  const b${index} = 2;\n`).join('')}  return false;\n}\n`;
  try {
    fs.writeFileSync(path.join(root, 'kernel.ts'), source);
    const ranges = (
      await Promise.all([1, 2].map((index) => shardFiles(['kernel.ts'], { index, count: 2 }, root)))
    ).flat();
    assert.ok(ranges.length >= 2);
    const offset = (line: number, column: number) =>
      source
        .split('\n')
        .slice(0, line - 1)
        .reduce((sum, text) => sum + text.length + 1, 0) + column;
    const spans = ranges
      .map((range) => {
        const match = /:(\d+):(\d+)-(\d+):(\d+)$/.exec(range)!;
        return {
          start: offset(Number(match[1]), Number(match[2])),
          end: offset(Number(match[3]), Number(match[4])),
        };
      })
      .sort((a, b) => a.start - b.start);
    assert.equal(spans[0]!.start, 0);
    for (let index = 1; index < spans.length; index++) {
      assert.equal(spans[index - 1]!.end, spans[index]!.start);
    }
    assert.equal(spans.at(-1)!.end, source.length);
    for (const statement of parseSync('kernel.ts', source).program.body) {
      assert.equal(
        spans.filter((range) => range.start <= statement.start && range.end >= statement.end)
          .length,
        1,
      );
    }
    assert.notDeepEqual(
      await shardFiles(['kernel.ts'], { index: 1, count: 2 }, root),
      await shardFiles(['kernel.ts'], { index: 2, count: 2 }, root),
    );
    await assert.rejects(
      () => shardFiles(['kernel.ts'], { index: 8, count: 8 }, root),
      /no sources/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
