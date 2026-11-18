import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import type { AppError } from '@agent-device/kernel/errors';
import {
  chunkAndroidImeHelperText,
  clearAndroidImeHelperTextCommitted,
  probeAndroidImeHelperAckSupport,
  resetAndroidImeHelperAckCacheForTests,
  sendAndroidImeHelperText,
  sendAndroidImeHelperTextCommitted,
} from '../ime-helper.ts';
import type { AndroidAdbExecutor } from '../adb-executor.ts';

const PACKAGE = 'com.callstack.agentdevice.imehelper';
const PROBE_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_PROBE';
const CLEAR_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT';
const INPUT_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64';

const PROBE_OK =
  'Broadcast completed: result=100, data="android-ime-helper-v2", extras: Bundle[mParcelledData.dataSize=116]\n';
const NO_RECEIVER = 'Broadcasting: Intent { act=... }\nBroadcast completed: result=0\n';

function ackCommitted(utf16: number): string {
  return `Broadcast completed: result=1, data="utf16=${utf16}"\n`;
}

beforeEach(() => {
  resetAndroidImeHelperAckCacheForTests();
});

/** A fake adb that answers the probe with `probeStdout` and every text/clear broadcast per `handler`. */
function fakeAdb(options: {
  probeStdout: string;
  onDispatch?: (action: string | undefined, args: readonly string[]) => string;
}): { adb: AndroidAdbExecutor; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args[1] === 'am' && args[2] === 'broadcast') {
      const action = args[args.indexOf('-a') + 1];
      if (action === PROBE_ACTION) return { exitCode: 0, stdout: options.probeStdout, stderr: '' };
      const stdout = options.onDispatch?.(action, args) ?? ackCommitted(0);
      return { exitCode: 0, stdout, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { adb, calls };
}

test('chunkAndroidImeHelperText never splits a surrogate pair and stays within the declared byte bound', () => {
  // 12_000 emoji = 48_000 UTF-8 bytes = exactly one full chunk; the next code point forces a split.
  const text = '😀'.repeat(12_000) + 'a' + 'b'.repeat(100);
  const chunks = chunkAndroidImeHelperText(text);
  assert.equal(chunks.length, 2);
  assert.equal(Buffer.byteLength(chunks[0] ?? '', 'utf8'), 48_000);
  assert.equal(chunks[0], '😀'.repeat(12_000), 'chunk boundary is code-point-safe');
  assert.equal(chunks.join(''), text, 'chunking preserves the text exactly and in order');
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 48_000);
    assert.ok(Buffer.from(chunk, 'utf8').toString('base64').length <= 64_000);
  }
  assert.deepEqual(chunkAndroidImeHelperText(''), ['']);
});

test('sendAndroidImeHelperText classifies the ordered ack: committed, rejections, and no-ack', async () => {
  const committed = fakeAdb({
    probeStdout: PROBE_OK,
    onDispatch: (action, args) => {
      if (action === INPUT_ACTION) {
        const payload = args[args.indexOf('text') + 1] ?? '';
        return ackCommitted(Buffer.from(payload, 'base64').toString('utf8').length);
      }
      return ackCommitted(0);
    },
  });
  assert.deepEqual(await sendAndroidImeHelperText(committed.adb, PACKAGE, '你好😀'), {
    kind: 'committed',
    attemptedUtf16: 4,
  });

  const falseReturn = fakeAdb({
    probeStdout: PROBE_OK,
    onDispatch: () => 'Broadcast completed: result=2, data="utf16=3"\n',
  });
  assert.deepEqual(await sendAndroidImeHelperText(falseReturn.adb, PACKAGE, 'abc'), {
    kind: 'commit-returned-false',
    attemptedUtf16: 3,
  });

  const noEditor = fakeAdb({
    probeStdout: PROBE_OK,
    onDispatch: () => 'Broadcast completed: result=3, data="no-input-connection"\n',
  });
  assert.deepEqual(await sendAndroidImeHelperText(noEditor.adb, PACKAGE, 'abc'), {
    kind: 'no-input-connection',
  });

  const rejected = fakeAdb({
    probeStdout: PROBE_OK,
    onDispatch: () => 'Broadcast completed: result=4, data="too-large"\n',
  });
  assert.deepEqual(await sendAndroidImeHelperText(rejected.adb, PACKAGE, 'abc'), {
    kind: 'rejected-payload',
    detail: 'too-large',
  });

  // result=0 is what the transport prints with no receiver AND what a pre-ack helper prints for a
  // probe: indistinguishable, and therefore never success evidence.
  const noAck = fakeAdb({ probeStdout: NO_RECEIVER, onDispatch: () => NO_RECEIVER });
  assert.deepEqual(await sendAndroidImeHelperText(noAck.adb, PACKAGE, 'abc'), { kind: 'no-ack' });
});

test('a probe returning result=0 refuses capability — no optimistic fallback', async () => {
  const { adb, calls } = fakeAdb({ probeStdout: NO_RECEIVER });
  assert.equal(await probeAndroidImeHelperAckSupport(adb, PACKAGE, 'android:emulator-5554'), false);
  await assert.rejects(
    sendAndroidImeHelperTextCommitted(adb, PACKAGE, 'android:emulator-5554', 'hello'),
    (error: AppError) => {
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.failureReason, 'android_ime_helper_no_ack');
      return true;
    },
  );
  // The probe refused the dispatch: no text broadcast may follow it.
  assert.equal(
    calls.filter((args) => args.includes(INPUT_ACTION)).length,
    0,
    'no text dispatch after a refused probe',
  );
});

test('a committed ack with a shorter attempted length than requested is a truthful failure', async () => {
  const { adb } = fakeAdb({
    probeStdout: PROBE_OK,
    onDispatch: () => ackCommitted(2), // requested 5, ack claims 2: truncation must not pass
  });
  await assert.rejects(
    sendAndroidImeHelperTextCommitted(adb, PACKAGE, 'android:emulator-5554', 'hello'),
    (error: AppError) => {
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.failureReason, 'android_ime_helper_dispatch_rejected');
      assert.equal(error.details?.attemptedUtf16, 2);
      assert.equal(error.details?.requestedUtf16, 5);
      return true;
    },
  );
});

test('receiver-reported rejections surface as typed dispatch failures with codes/lengths only', async () => {
  for (const [stdout, kind] of [
    ['Broadcast completed: result=2, data="utf16=5"\n', 'commit-returned-false'],
    ['Broadcast completed: result=3, data="no-input-connection"\n', 'no-input-connection'],
    ['Broadcast completed: result=4, data="bad-base64"\n', 'rejected-payload'],
    ['Broadcast completed: result=5, data="protocol"\n', 'protocol-mismatch'],
  ] as const) {
    const { adb } = fakeAdb({ probeStdout: PROBE_OK, onDispatch: () => stdout });
    await assert.rejects(
      sendAndroidImeHelperTextCommitted(adb, PACKAGE, 'android:emulator-5554', 'hello'),
      (error: AppError) => {
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.equal(error.details?.failureReason, 'android_ime_helper_dispatch_rejected');
        assert.equal(error.details?.dispatchKind, kind);
        assert.equal(
          JSON.stringify(error.details).includes('hello'),
          false,
          'error details carry codes/lengths only, never user text',
        );
        return true;
      },
    );
  }
});

test('the capability probe is sent once per device and reused by later dispatches', async () => {
  const { adb, calls } = fakeAdb({
    probeStdout: PROBE_OK,
    onDispatch: (action, args) => {
      if (action === INPUT_ACTION) {
        const payload = args[args.indexOf('text') + 1] ?? '';
        return ackCommitted(Buffer.from(payload, 'base64').toString('utf8').length);
      }
      return ackCommitted(0);
    },
  });
  await sendAndroidImeHelperTextCommitted(adb, PACKAGE, 'android:emulator-5554', 'one');
  await sendAndroidImeHelperTextCommitted(adb, PACKAGE, 'android:emulator-5554', 'two');
  await clearAndroidImeHelperTextCommitted(adb, PACKAGE, 'android:emulator-5554');
  assert.equal(calls.filter((args) => args.includes(PROBE_ACTION)).length, 1);
  assert.equal(calls.filter((args) => args.includes(INPUT_ACTION)).length, 2);
  assert.equal(calls.filter((args) => args.includes(CLEAR_ACTION)).length, 1);
});

test('a malformed ack line (no result code) is no-ack, not success', async () => {
  const { adb } = fakeAdb({ probeStdout: 'Broadcasting: Intent { act=... }\n' });
  assert.equal(await probeAndroidImeHelperAckSupport(adb, PACKAGE, 'android:emulator-5554'), false);
});
