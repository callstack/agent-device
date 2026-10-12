import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import path from 'node:path';
import { test } from 'node:test';
import { parseSync } from 'oxc-parser';
import { shardFiles } from './sharding.ts';

test('a single-file kernel is split without losing or duplicating statement-spanning mutants', () => {
  const root = fs.realpathSync(mkdtempForTestSync('mutation-sharding-'));
  const source = `export const label = "🧪";\nexport function first() {\n${Array.from({ length: 15 }, (_, index) => `  const a${index} = 1;\n`).join('')}  return true;\n}\nexport const second = false;\nexport function third() {\n${Array.from({ length: 15 }, (_, index) => `  const b${index} = 2;\n`).join('')}  return false;\n}\n`;
  try {
    fs.writeFileSync(path.join(root, 'kernel.ts'), source);
    const ranges = [1, 2].flatMap((index) => shardFiles(['kernel.ts'], { index, count: 2 }, root));
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
      shardFiles(['kernel.ts'], { index: 1, count: 2 }, root),
      shardFiles(['kernel.ts'], { index: 2, count: 2 }, root),
    );
    assert.throws(() => shardFiles(['kernel.ts'], { index: 8, count: 8 }, root), /no sources/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
