import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const synthesizedTextEntryPath = path.join(
  repoRoot,
  'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+SynthesizedTextEntry.swift',
);

// The synthesized bare-type commit wait polls the target field's live value on the shipped
// `type` path. That value is user content — a `type` command may carry credentials, tokens, or
// PII — and runner.log persists across the session. Cadence evidence must stay value-free:
// lengths, timestamps, and enum names only.
//
// Guard shape: every NSLog format string in the module that interpolates a string (%@) must be
// on this allowlist of static, non-field-content formats. Reintroducing raw observed text into
// runner logging requires adding a new %@ format here, which fails this test until a human
// reviews it.
const allowedStringInterpolatingFormats = new Set([
  'AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=%@',
  'AGENT_DEVICE_RUNNER_TEXT_ENTRY_ROUTE route=verified-fallback reason=%@',
  'AGENT_DEVICE_RUNNER_TEXT_ENTRY_PHASE commandId=%@ phase=%@ durationMs=%.1f chars=%d mode=%@',
  '[DEBUG-1874] wait outcome=%@ elapsedMs=%.0f',
]);

function extractNSLogStatements(source: string): string[] {
  const statements: string[] = [];
  let index = source.indexOf('NSLog(');
  while (index !== -1) {
    let depth = 0;
    let cursor = index + 'NSLog'.length;
    for (; cursor < source.length; cursor += 1) {
      if (source[cursor] === '(') depth += 1;
      if (source[cursor] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    statements.push(source.slice(index, cursor + 1));
    index = source.indexOf('NSLog(', cursor);
  }
  return statements;
}

test('synthesized text entry logging stays free of observed field contents', () => {
  const source = fs.readFileSync(synthesizedTextEntryPath, 'utf8');
  const statements = extractNSLogStatements(source);
  assert.ok(statements.length > 0, 'expected NSLog statements in the module');

  for (const statement of statements) {
    const formatMatch = statement.match(/"((?:[^"\\]|\\.)*)"/);
    assert.ok(formatMatch, `NSLog without a literal format string: ${statement}`);
    const format = formatMatch[1];
    if (!format.includes('%@')) continue;
    assert.ok(
      allowedStringInterpolatingFormats.has(format),
      `unreviewed string-interpolating log format "${format}" — field contents must never reach runner.log`,
    );
  }

  // The invariant this module must keep: cadence evidence names lengths, not contents.
  assert.match(
    source,
    /poll t=%\.0fms observedLen=%ld expectedPrefixLen=%ld/,
    'commit-wait polling must log value-free cadence evidence',
  );
});
