import assert from 'node:assert/strict';
import fs from 'node:fs';

import { assertPngFile } from '../provider-scenarios/assertions.ts';
import type { CliJsonResult } from '../cli-json.ts';
import { type LiveContext, runStep, verifyCommand } from './live-harness.ts';

export function assertJsonContains(result: CliJsonResult, expected: string, message: string): void {
  const serialized = JSON.stringify(result.json?.data ?? result.json);
  assert.ok(serialized.includes(expected), `${message}\nreceived: ${serialized}`);
}

export async function assertWaitText(context: LiveContext, expected: string): Promise<void> {
  const result = await runStep(context, `wait for ${expected}`, [
    'wait',
    'text',
    expected,
    '10000',
  ]);
  assertJsonContains(result, expected, `wait should observe ${expected}`);
  verifyCommand(context, 'wait', `wait observes durable text: ${expected}`);
}

export async function assertElementText(
  context: LiveContext,
  selector: string,
  expected: string,
): Promise<void> {
  const result = await runStep(context, `read ${selector}`, ['get', 'text', selector]);
  assert.equal(result.json?.data?.text, expected, `${selector}: ${JSON.stringify(result.json)}`);
}

export async function capturePng(
  context: LiveContext,
  step: string,
  outputPath: string,
): Promise<void> {
  await runStep(context, step, ['screenshot', outputPath, '--max-size', '900']);
  assertPngFile(outputPath);
}

export function assertFilesDiffer(first: string, second: string, message: string): void {
  assert.notDeepEqual(fs.readFileSync(first), fs.readFileSync(second), message);
}

export function requireAndroidResourceId(
  result: CliJsonResult,
  suffix: string,
): {
  identifier: string;
  rect: { height: number; width: number; x: number; y: number };
} {
  const nodes = Array.isArray(result.json?.data?.nodes) ? result.json.data.nodes : [];
  const node = nodes.find(
    (candidate: { identifier?: unknown }) =>
      typeof candidate.identifier === 'string' &&
      (candidate.identifier === suffix || candidate.identifier.endsWith(`:id/${suffix}`)),
  );
  assert.ok(
    node,
    `snapshot missing Android resource-id for ${suffix}: ${JSON.stringify(result.json)}`,
  );
  const rect = (node as { rect?: unknown }).rect;
  assert.ok(rect && typeof rect === 'object', `resource-id ${suffix} has no rect`);
  const typedRect = rect as { height: number; width: number; x: number; y: number };
  for (const value of [typedRect.x, typedRect.y, typedRect.width, typedRect.height]) {
    assert.ok(Number.isFinite(value), `resource-id ${suffix} has invalid rect`);
  }
  return { identifier: (node as { identifier: string }).identifier, rect: typedRect };
}
