import assert from 'node:assert/strict';
import fs from 'node:fs';

import { assertPngFile } from '../provider-scenarios/assertions.ts';
import { isPlayableVideo } from '../../../src/utils/video.ts';
import type { CliJsonResult } from '../cli-json.ts';
import type { LiveDeviceContext } from './runtime.ts';

type RunStep<Context> = (
  context: Context,
  step: string,
  args: string[],
  options?: { allowFailure?: boolean },
) => Promise<CliJsonResult>;

export function createLiveDeviceAssertions<
  BehaviorId extends string,
  Context extends LiveDeviceContext<BehaviorId>,
>(
  runStep: RunStep<Context>,
  verifyCommand: (context: Context, command: string, evidence: string) => void,
  waitCommand: string,
) {
  async function assertWaitText(context: Context, expected: string): Promise<void> {
    const result = await runStep(context, `wait for ${expected}`, [
      'wait',
      'text',
      expected,
      '10000',
    ]);
    assertJsonContains(result, expected, `wait should observe ${expected}`);
    verifyCommand(context, waitCommand, `wait observes durable text: ${expected}`);
  }

  async function assertWaitSelector(context: Context, selector: string): Promise<void> {
    await runStep(context, `wait for ${selector}`, ['wait', selector, '10000']);
    verifyCommand(context, waitCommand, `wait observes durable selector: ${selector}`);
  }

  async function assertElementText(
    context: Context,
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

  async function capturePng(context: Context, step: string, outputPath: string): Promise<void> {
    await runStep(context, step, ['screenshot', outputPath, '--max-size', '900']);
    assertPngFile(outputPath);
  }

  return { assertElementText, assertWaitSelector, assertWaitText, capturePng };
}

export function assertJsonContains(result: CliJsonResult, expected: string, message: string): void {
  const serialized = JSON.stringify(result.json?.data ?? result.json);
  assert.ok(serialized.includes(expected), `${message}\nreceived: ${serialized}`);
}

export function assertFilesDiffer(first: string, second: string, message: string): void {
  assert.notDeepEqual(fs.readFileSync(first), fs.readFileSync(second), message);
}

export function assertNonEmptyFile(filePath: string, name: string): void {
  assert.ok(fs.statSync(filePath).size > 0, `${name} artifact is empty: ${filePath}`);
}

export async function assertMp4File(filePath: string): Promise<void> {
  assertNonEmptyFile(filePath, 'recording');
  assert.equal(
    await isPlayableVideo(filePath),
    true,
    `recording is not a finalized playable video: ${filePath}`,
  );
}
