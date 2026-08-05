import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PNG } from '../../../src/utils/png.ts';
import type { ProviderScenarioRpcResult } from './harness.ts';

export function assertCommandCall(calls: readonly string[][], expected: readonly string[]): void {
  assert.ok(
    calls.some((call) => arrayEqual(call, expected)),
    `Expected command call ${JSON.stringify(expected)} in ${JSON.stringify(calls)}`,
  );
}

export function assertFlatToolCall(
  calls: Array<[string, ...string[]]>,
  expected: [string, ...string[]],
): void {
  assert.ok(
    calls.some((call) => arrayEqual(call, expected)),
    `Expected tool call ${JSON.stringify(expected)} in ${JSON.stringify(calls)}`,
  );
}

export function assertFlatToolCallStartsWith(
  calls: Array<[string, ...string[]]>,
  expected: [string, ...string[]],
): void {
  assert.ok(
    calls.some((call) => arrayStartsWith(call, expected)),
    `Expected tool call starting with ${JSON.stringify(expected)} in ${JSON.stringify(calls)}`,
  );
}

export function assertRpcOk<TData extends Record<string, unknown> = Record<string, unknown>>(
  response: ProviderScenarioRpcResult,
): TData {
  assert.equal(response.statusCode, 200, JSON.stringify(response.json));
  assert.equal(response.json?.error, undefined, JSON.stringify(response.json));
  return (response.json?.result?.data ?? {}) as TData;
}

export function assertRpcError(
  response: ProviderScenarioRpcResult,
  code: string,
  message: RegExp,
): Record<string, unknown> {
  assert.equal(response.statusCode, 200, JSON.stringify(response.json));
  assert.equal(response.json?.error?.data?.code, code, JSON.stringify(response.json));
  assert.match(response.json?.error?.message ?? '', message);
  return (response.json?.error?.data ?? {}) as Record<string, unknown>;
}

export function assertRecordingStarted(
  response: ProviderScenarioRpcResult,
  options: { outPath?: string; showTouches?: boolean } = {},
): void {
  const data = assertRpcOk<{
    recording?: unknown;
    outPath?: unknown;
    showTouches?: unknown;
  }>(response);
  assert.equal(data.recording, 'started');
  if (options.outPath !== undefined) {
    assert.equal(data.outPath, options.outPath);
  }
  if ('showTouches' in options) {
    assert.equal(data.showTouches, options.showTouches);
  }
}

export function assertRecordingStopped(
  response: ProviderScenarioRpcResult,
  outPath: string,
  options: { showTouches?: boolean } = {},
): void {
  const data = assertRpcOk<{
    recording?: unknown;
    outPath?: unknown;
    showTouches?: unknown;
    artifacts?: Array<{ path?: unknown }>;
  }>(response);
  assert.equal(data.recording, 'stopped');
  assert.equal(data.outPath, outPath);
  if ('showTouches' in options) {
    assert.equal(data.showTouches, options.showTouches);
  }
  assert.equal(data.artifacts?.[0]?.path, outPath);
}

export function arrayEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function arrayStartsWith(left: readonly string[], right: readonly string[]): boolean {
  return right.every((value, index) => left[index] === value);
}

export function validPng(): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function pngSignature(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

export function assertPngFile(filePath: string): void {
  assert.deepEqual(fs.readFileSync(filePath).subarray(0, 8), pngSignature());
}

export function assertPngDimensions(filePath: string, width: number, height: number): void {
  const png = PNG.sync.read(fs.readFileSync(filePath));
  assert.equal(png.width, width);
  assert.equal(png.height, height);
}
