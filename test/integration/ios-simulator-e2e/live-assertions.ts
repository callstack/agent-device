import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PUBLIC_COMMANDS } from '../../../src/command-catalog.ts';
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
  verifyCommand(context, PUBLIC_COMMANDS.wait, `wait observes durable text: ${expected}`);
}

export async function assertElementText(
  context: LiveContext,
  selector: string,
  expected: string,
): Promise<void> {
  const result = await runStep(context, `read ${selector}`, ['get', 'text', selector]);
  assert.equal(
    result.json?.data?.text,
    expected,
    `${selector} should expose ${expected}: ${JSON.stringify(result.json)}`,
  );
}

export function assertNonEmptyFile(filePath: string, name: string): void {
  assert.ok(fs.statSync(filePath).size > 0, `${name} artifact is empty: ${filePath}`);
}

export function assertMp4File(filePath: string): void {
  assertNonEmptyFile(filePath, 'recording');
  const header = fs.readFileSync(filePath).subarray(0, 32).toString('latin1');
  assert.ok(header.includes('ftyp'), `recording has no MP4 ftyp atom: ${filePath}`);
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

function requireNode(
  result: CliJsonResult,
  identifier: string,
): { label?: unknown; rect?: { height: number; width: number; x: number; y: number } } {
  const nodes = Array.isArray(result.json?.data?.nodes) ? result.json.data.nodes : [];
  const node = nodes.find(
    (candidate: { identifier?: unknown }) => candidate.identifier === identifier,
  );
  assert.ok(node, `snapshot missing ${identifier}: ${JSON.stringify(result.json)}`);
  return node;
}

export function requireNodeRect(
  result: CliJsonResult,
  identifier: string,
): { height: number; width: number; x: number; y: number } {
  const rect = requireNode(result, identifier).rect;
  assert.ok(rect, `snapshot node ${identifier} has no rect: ${JSON.stringify(result.json)}`);
  for (const value of [rect.x, rect.y, rect.width, rect.height]) {
    assert.ok(Number.isFinite(value), `snapshot node ${identifier} has invalid rect`);
  }
  return rect;
}

export function requireDevice(result: CliJsonResult, udid: string): { booted?: unknown } {
  const devices = Array.isArray(result.json?.data?.devices) ? result.json.data.devices : [];
  const device = devices.find((candidate: { id?: unknown }) => candidate.id === udid);
  assert.ok(device, `device inventory missing ${udid}: ${JSON.stringify(result.json)}`);
  return device;
}
