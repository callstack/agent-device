import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const commandExecutionSwiftPath = path.join(
  repoRoot,
  'apple-runner/AgentDeviceRunner/AgentDeviceRunnerUITests/RunnerTests+CommandExecution.swift',
);

test('Apple gesture command preserves the fling fast-swipe and coordinate fallback route', () => {
  const source = fs.readFileSync(commandExecutionSwiftPath, 'utf8');
  const gestureCase = extractSwiftSwitchCase(source, '.gesture', '.gestureViewport');
  const fastSwipeBranch = extractSourceSegment(
    gestureCase,
    'if plannedGestureExecution(for: plan) == .fastSwipe',
    'let (timing, outcome)',
  );

  assert.match(fastSwipeBranch, /executeDragGesture\(/);
  assert.match(fastSwipeBranch, /synthesized:\s*true/);
  assert.match(fastSwipeBranch, /synthesizedPolicyKind:\s*\.synthesizedDrag/);
  assert.match(fastSwipeBranch, /synthesizedProfile:\s*\.fastSwipe/);
  assert.doesNotMatch(fastSwipeBranch, /sampledPlannedGesture/);

  const dragExecutor = extractSwiftFunction(source, 'executeDragGesture');
  assert.match(
    dragExecutor,
    /fallback = gestureFallback\(strategy: "xctest-coordinate-drag", from: outcome\)/,
  );
  assert.match(dragExecutor, /dragAt\(/);
});

function extractSwiftSwitchCase(source: string, name: string, nextName: string): string {
  return extractSourceSegment(source, `case ${name}:`, `case ${nextName}:`);
}

function extractSourceSegment(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing source marker ${endMarker}`);
  return source.slice(start, end);
}

function extractSwiftFunction(source: string, name: string): string {
  const signatureIndex = source.indexOf(`func ${name}`);
  assert.notEqual(signatureIndex, -1, `missing Swift function ${name}`);
  const bodyStart = source.indexOf('{', signatureIndex);
  assert.notEqual(bodyStart, -1, `missing Swift function body ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(signatureIndex, index + 1);
  }
  assert.fail(`unterminated Swift function ${name}`);
}
