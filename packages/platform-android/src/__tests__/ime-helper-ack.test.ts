import assert from 'node:assert/strict';
import { test } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import type { AppError } from '@agent-device/kernel/errors';
import {
  chunkAndroidImeHelperText,
  clearAndroidImeHelperTextCommitted,
  sendAndroidImeHelperText,
  sendAndroidImeHelperTextCommitted,
} from '../ime-helper.ts';
import type { AndroidAdbExecutor } from '../adb-executor.ts';

const PACKAGE = 'com.callstack.agentdevice.imehelper';
const CLEAR_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT';
const INPUT_ACTION = 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64';

const NO_RECEIVER = 'Broadcasting: Intent { act=... }\nBroadcast completed: result=0\n';

function ackCommitted(utf16: number): string {
  return `Broadcast completed: result=1, data="utf16=${utf16}"\n`;
}

function fakeAdb(options: {
  onDispatch?: (action: string | undefined, args: readonly string[]) => string;
}): { adb: AndroidAdbExecutor; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const adb: AndroidAdbExecutor = async (args) => {
    calls.push(args);
    if (args[1] === 'am' && args[2] === 'broadcast') {
      const action = args[args.indexOf('-a') + 1];
      const stdout = options.onDispatch?.(action, args) ?? ackCommitted(0);
      return { exitCode: 0, stdout, stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { adb, calls };
}

test('chunkAndroidImeHelperText never splits a surrogate pair and stays within the declared byte bound', () => {
  const text = 'a' + '😀'.repeat(12_000) + 'b'.repeat(100);
  const chunks = chunkAndroidImeHelperText(text);
  assert.equal(chunks.length, 2);
  assert.equal(Buffer.byteLength(chunks[0] ?? '', 'utf8'), 47_997);
  assert.equal(chunks[0], 'a' + '😀'.repeat(11_999), 'chunk boundary is code-point-safe');
  assert.equal(chunks.join(''), text, 'chunking preserves the text exactly and in order');
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 48_000);
    assert.ok(Buffer.from(chunk, 'utf8').toString('base64').length <= 64_000);
  }
  assert.deepEqual(chunkAndroidImeHelperText(''), ['']);
});

test('sendAndroidImeHelperText classifies the ordered ack: committed, rejections, and no-ack', async () => {
  const committed = fakeAdb({
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
    onDispatch: () => 'Broadcast completed: result=2, data="utf16=3"\n',
  });
  assert.deepEqual(await sendAndroidImeHelperText(falseReturn.adb, PACKAGE, 'abc'), {
    kind: 'commit-returned-false',
    attemptedUtf16: 3,
  });

  const noEditor = fakeAdb({
    onDispatch: () => 'Broadcast completed: result=3, data="no-input-connection"\n',
  });
  assert.deepEqual(await sendAndroidImeHelperText(noEditor.adb, PACKAGE, 'abc'), {
    kind: 'no-input-connection',
  });

  const rejected = fakeAdb({
    onDispatch: () => 'Broadcast completed: result=4, data="too-large"\n',
  });
  assert.deepEqual(await sendAndroidImeHelperText(rejected.adb, PACKAGE, 'abc'), {
    kind: 'rejected-payload',
    detail: 'too-large',
  });

  const noAck = fakeAdb({ onDispatch: () => NO_RECEIVER });
  assert.deepEqual(await sendAndroidImeHelperText(noAck.adb, PACKAGE, 'abc'), { kind: 'no-ack' });
});

test('the first text broadcast without an ordered acknowledgement fails without another send', async () => {
  const { adb, calls } = fakeAdb({ onDispatch: () => NO_RECEIVER });
  await assert.rejects(
    sendAndroidImeHelperTextCommitted(adb, PACKAGE, 'hello'),
    (error: AppError) => {
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'android_ime_helper_no_ack');
      assert.match(String(error.details?.hint), /reinstall/i);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.includes(INPUT_ACTION));
  assert.ok(calls[0]?.includes('android-ime-helper-v2'));
});

test('a committed ack with a shorter attempted length than requested is a truthful failure', async () => {
  const { adb } = fakeAdb({
    onDispatch: () => ackCommitted(2), // requested 5, ack claims 2: truncation must not pass
  });
  await assert.rejects(
    sendAndroidImeHelperTextCommitted(adb, PACKAGE, 'hello'),
    (error: AppError) => {
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, 'android_ime_helper_dispatch_rejected');
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
    const { adb } = fakeAdb({ onDispatch: () => stdout });
    await assert.rejects(
      sendAndroidImeHelperTextCommitted(adb, PACKAGE, 'hello'),
      (error: AppError) => {
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.equal(error.details?.reason, 'android_ime_helper_dispatch_rejected');
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

test('each text or clear operation sends one ordered broadcast', async () => {
  const { adb, calls } = fakeAdb({
    onDispatch: (action, args) => {
      if (action === INPUT_ACTION) {
        const payload = args[args.indexOf('text') + 1] ?? '';
        return ackCommitted(Buffer.from(payload, 'base64').toString('utf8').length);
      }
      return ackCommitted(0);
    },
  });
  await sendAndroidImeHelperTextCommitted(adb, PACKAGE, 'one');
  await sendAndroidImeHelperTextCommitted(adb, PACKAGE, 'two');
  await clearAndroidImeHelperTextCommitted(adb, PACKAGE);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter((args) => args.includes(INPUT_ACTION)).length, 2);
  assert.equal(calls.filter((args) => args.includes(CLEAR_ACTION)).length, 1);
});

test('a malformed ack line is no-ack', async () => {
  const { adb } = fakeAdb({ onDispatch: () => 'Broadcasting: Intent { act=... }\n' });
  assert.deepEqual(await sendAndroidImeHelperText(adb, PACKAGE, 'hello'), { kind: 'no-ack' });
});
