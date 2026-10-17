import { test } from 'vitest';
import { bindTestCommandHost } from '@agent-device/test-kit';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { copyCoreDeviceRunnerFile } from '../physical-device-files.ts';
import { IOS_DEVICE } from '../../__tests__/device-fixtures.ts';
import { withFakeAppleTool, type FakeAppleToolScript } from '../../__tests__/fake-apple-tool.ts';

/**
 * `copyCoreDeviceRunnerFile` copies one file out of the runner's app data container. The container
 * is owned by whichever bundle id Xcode happened to install the runner under, so the copy tries the
 * candidate bundle ids in order and reports only what the last one said. The shapes below pin the
 * retry boundary (one success stops the loop) and each source of the reported message.
 */
bindTestCommandHost();

test('copyCoreDeviceRunnerFile copies with the app data container domain', async () => {
  const calls = await runCopy(() => '');
  assert.equal(calls.length, 1);
  const args = calls[0]!;
  assert.deepEqual(args.slice(0, 4), ['devicectl', 'device', 'copy', 'from']);
  assert.equal(args[args.indexOf('--source') + 1], '/tmp/shot.png');
  assert.equal(args[args.indexOf('--destination') + 1], '/out/shot.png');
  assert.equal(args[args.indexOf('--domain-type') + 1], 'appDataContainer');
});

test('copyCoreDeviceRunnerFile retries the next runner container and stops at the one that answers', async () => {
  // The container is owned by whichever bundle id the runner was installed under, so a miss must
  // move to the next candidate rather than fail the copy, and the hit must stop the loop there.
  let attempts = 0;
  const calls = await runCopy(() => {
    attempts += 1;
    return attempts === 1 ? { exitCode: 1, stderr: 'no such container' } : '';
  });
  assert.equal(calls.length, 2);
  assert.notEqual(domainIdentifier(calls[0]!), domainIdentifier(calls[1]!));
});

test('copyCoreDeviceRunnerFile reports the last container error', async () => {
  // Distinct per-attempt errors: reporting an earlier candidate's failure instead of the final
  // one is the regression this pins, so the message must carry the last attempt's text only.
  const calls: string[][] = [];
  await assert.rejects(
    async () =>
      await withFakeAppleTool(
        (args) => {
          calls.push(args);
          return { exitCode: 1, stderr: `container miss ${calls.length}` };
        },
        async () => await copyCoreDeviceRunnerFile(IOS_DEVICE, '/tmp/shot.png', '/out/shot.png'),
        { device: IOS_DEVICE },
      ),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      // Every candidate container is tried, and the report names the last one alone.
      assert.ok(calls.length >= 2, 'every candidate container must be tried');
      assert.ok(domainIdentifier(calls[0]!) !== domainIdentifier(calls[1]!));
      assert.ok(message.endsWith(`container miss ${calls.length}`), message);
      return true;
    },
  );
});

test('copyCoreDeviceRunnerFile falls back to stdout when stderr is empty', async () => {
  await assertCopyFailure(
    () => ({ exitCode: 1, stdout: '  container unavailable  ' }),
    /Failed to copy runner file from iOS device: container unavailable/,
  );
});

test('copyCoreDeviceRunnerFile names the exit code when the copy said nothing', async () => {
  await assertCopyFailure(
    () => ({ exitCode: 3, stdout: '', stderr: '' }),
    /Failed to copy runner file from iOS device: devicectl exited with code 3/,
  );
});

test('copyCoreDeviceRunnerFile refuses to start once the deadline is spent', async () => {
  const calls: string[][] = [];
  await assert.rejects(
    async () =>
      await withFakeAppleTool(
        (args) => {
          calls.push(args);
          return '';
        },
        async () => await copyCoreDeviceRunnerFile(IOS_DEVICE, '/tmp/shot.png', '/out/shot.png', 0),
        { device: IOS_DEVICE },
      ),
    (error: unknown) => {
      // The message alone says only "timed out"; the typed step is what tells the caller the
      // spent deadline was the file copy's, not another phase of the physical-device flow.
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.match(error.message, /iOS runner file copy timed out after 0ms/);
      assert.equal(error.details?.step, 'runner file copy');
      assert.equal(error.details?.timeoutMs, 0);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

function domainIdentifier(args: string[]): string {
  return args[args.indexOf('--domain-identifier') + 1] ?? '';
}

async function runCopy(script: FakeAppleToolScript): Promise<string[][]> {
  return await withFakeAppleTool(
    script,
    async ({ calls }) => {
      await copyCoreDeviceRunnerFile(IOS_DEVICE, '/tmp/shot.png', '/out/shot.png');
      return calls;
    },
    { device: IOS_DEVICE },
  );
}

async function assertCopyFailure(script: FakeAppleToolScript, message: RegExp): Promise<void> {
  await assert.rejects(
    async () =>
      await withFakeAppleTool(
        script,
        async () => await copyCoreDeviceRunnerFile(IOS_DEVICE, '/tmp/shot.png', '/out/shot.png'),
        { device: IOS_DEVICE },
      ),
    message,
  );
}
