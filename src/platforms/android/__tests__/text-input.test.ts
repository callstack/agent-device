import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fillAndroid, typeAndroid } from '../text-input.ts';
import { assertRejectsAppError } from '../../../__tests__/test-utils/app-error.ts';
import {
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  androidSnapshotHelperScriptResponse,
} from '../../../__tests__/test-utils/android-snapshot-helper.ts';
import { withFakeAdb } from '../../../__tests__/test-utils/fake-adb.ts';

// The fake adb provider installs through the production withAndroidAdbProvider
// scope, so `calls` records device-scoped args without a leading `-s <serial>`.

function isShellInput(args: string[], subcommand: 'tap' | 'text'): boolean {
  return args[0] === 'shell' && args[1] === 'input' && args[2] === subcommand;
}

function isShellKeyevent(args: string[], keycode: string): boolean {
  return (
    args[0] === 'shell' && args[1] === 'input' && args[2] === 'keyevent' && args[3] === keycode
  );
}

test('typeAndroid chunks ASCII input text for shell fallback', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, 'filed the expense');
      assert.deepEqual(shellInputTextCalls(calls), [
        ['shell', 'input', 'text', 'filed%sth'],
        ['shell', 'input', 'text', 'e%sexpens'],
        ['shell', 'input', 'text', 'e'],
      ]);
    },
  );
});

test('typeAndroid passes shell-sensitive ascii text to adb input text', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, 'curtis.layne+test+73kmc@uber.com');
      assert.deepEqual(shellInputTextCalls(calls), [
        ['shell', 'input', 'text', 'curtis.l'],
        ['shell', 'input', 'text', 'ayne+tes'],
        ['shell', 'input', 'text', 't+73kmc@'],
        ['shell', 'input', 'text', 'uber.com'],
      ]);
    },
  );
});

test('typeAndroid preserves percent signs while encoding spaces', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, '50% complete');
      assert.deepEqual(shellInputTextCalls(calls), [
        ['shell', 'input', 'text', '50%%scomp'],
        ['shell', 'input', 'text', 'lete'],
      ]);
    },
  );
});

test('typeAndroid sends one character at a time when delay is requested', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, 'hey', 1);
      assert.deepEqual(shellInputTextCalls(calls), [
        ['shell', 'input', 'text', 'h'],
        ['shell', 'input', 'text', 'e'],
        ['shell', 'input', 'text', 'y'],
      ]);
    },
  );
});

test('typeAndroid shell-quotes text containing shell metacharacters', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, 'otp; echo pwned');
      // The chunk carrying `;` is single-quoted so the device shell cannot
      // re-tokenize it into a second command.
      assert.deepEqual(shellInputTextCalls(calls), [
        ['shell', 'input', 'text', "'otp;%sech'"],
        ['shell', 'input', 'text', 'o%spwned'],
      ]);
    },
  );
});

test('typeAndroid leaves safe text unquoted', async () => {
  await withFakeAdb(
    () => undefined,
    async ({ calls, device }) => {
      await typeAndroid(device, 'hello');
      assert.deepEqual(shellInputTextCalls(calls), [['shell', 'input', 'text', 'hello']]);
    },
  );
});

test('fillAndroid uses chunk-safe shell input and retries when verification still fails', async () => {
  // First `input text` writes a wrong partial value, so attempt 1 fails
  // verification and production retries with the smaller chunk size.
  let state = '';
  let inputTextCount = 0;
  await withFakeAdb(
    (args) => {
      const helperResponse = snapshotHelperResponse(args, () => state);
      if (helperResponse !== undefined) return helperResponse;
      if (isShellInput(args, 'tap')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_MOVE_END')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_DEL')) {
        state = '';
        return undefined;
      }
      if (isShellInput(args, 'text')) {
        inputTextCount += 1;
        state = inputTextCount === 1 ? 'curti' : state + (args[3] ?? '');
        return undefined;
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      await fillAndroid(device, 10, 10, 'curtis.layne+test+73kmc@uber.com');
      assert.equal(
        calls.some((args) => args.join(' ').startsWith('shell cmd clipboard set text')),
        false,
      );
      assert.equal(
        calls.some((args) => args.includes('KEYCODE_PASTE')),
        false,
      );
      assert.ok(shellInputTextCalls(calls).length > 1);
    },
    {
      provider: { snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    },
  );
}, 15_000);

test('fillAndroid keeps delayed typing in typed-input mode', async () => {
  let state = '';
  await withFakeAdb(
    (args) => {
      const helperResponse = snapshotHelperResponse(args, () => state);
      if (helperResponse !== undefined) return helperResponse;
      if (isShellInput(args, 'tap')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_MOVE_END')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_DEL')) {
        state = '';
        return undefined;
      }
      if (isShellInput(args, 'text')) {
        state += args[3] ?? '';
        return undefined;
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      await fillAndroid(device, 10, 10, 'go', 1);
      assert.equal(shellInputTextCalls(calls).length, 2);
      assert.equal(
        calls.some((args) => args.join(' ').startsWith('shell cmd clipboard set text')),
        false,
      );
      assert.equal(
        calls.some((args) => args.includes('KEYCODE_PASTE')),
        false,
      );
    },
    {
      provider: { snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    },
  );
}, 15_000);

test('fillAndroid tolerates delayed React Native text verification', async () => {
  // The first hierarchy dump reports a stale truncated value (React Native
  // committing late); the later stability dumps report the real text.
  let state = '';
  let dumpCount = 0;
  await withFakeAdb(
    (args) => {
      const helperResponse = snapshotHelperResponse(args, () => {
        dumpCount += 1;
        return dumpCount === 1 ? 'sent the updat' : state;
      });
      if (helperResponse !== undefined) return helperResponse;
      if (isShellInput(args, 'tap')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_MOVE_END')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_DEL')) {
        state = '';
        return undefined;
      }
      if (isShellInput(args, 'text')) {
        state += (args[3] ?? '').replace(/%s/g, ' ');
        return undefined;
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ device }) => {
      await fillAndroid(device, 10, 10, 'sent the update');
    },
    {
      provider: { snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    },
  );
}, 10_000);

test('typeAndroid reports clear error when unicode input is unsupported', async () => {
  await withFakeAdb(
    (args) => {
      if (args.join(' ').startsWith('shell cmd clipboard set text')) {
        return 'No shell command implementation.';
      }
      if (isShellInput(args, 'text')) {
        return {
          stderr: "Exception occurred while executing 'text':\njava.lang.NullPointerException\n",
          exitCode: 255,
        };
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ device }) => {
      await assertRejectsAppError(() => typeAndroid(device, '很'), {
        code: 'COMMAND_FAILED',
        message: /provider-native text injection/i,
      });
    },
  );
});

test('fillAndroid keeps delayed typing in typed-input mode', async () => {
  let state = '';
  await withFakeAdb(
    (args) => {
      const helperResponse = snapshotHelperResponse(args, () => state);
      if (helperResponse !== undefined) return helperResponse;
      if (isShellInput(args, 'tap')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_MOVE_END')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_DEL')) {
        state = '';
        return undefined;
      }
      if (isShellInput(args, 'text')) {
        state += args[3] ?? '';
        return undefined;
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ calls, device }) => {
      await fillAndroid(device, 10, 10, 'go', 1);
      assert.equal(shellInputTextCalls(calls).length, 2);
      assert.equal(
        calls.some((args) => args.join(' ').startsWith('shell cmd clipboard set text')),
        false,
      );
      assert.equal(
        calls.some((args) => args.includes('KEYCODE_PASTE')),
        false,
      );
    },
    {
      provider: { snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    },
  );
}, 15_000);

test('fillAndroid tolerates delayed React Native text verification', async () => {
  // The first hierarchy dump reports a stale truncated value (React Native
  // committing late); the later stability dumps report the real text.
  let state = '';
  let dumpCount = 0;
  await withFakeAdb(
    (args) => {
      const helperResponse = snapshotHelperResponse(args, () => {
        dumpCount += 1;
        return dumpCount === 1 ? 'sent the updat' : state;
      });
      if (helperResponse !== undefined) return helperResponse;
      if (isShellInput(args, 'tap')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_MOVE_END')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_DEL')) {
        state = '';
        return undefined;
      }
      if (isShellInput(args, 'text')) {
        state += (args[3] ?? '').replace(/%s/g, ' ');
        return undefined;
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ device }) => {
      await fillAndroid(device, 10, 10, 'sent the update');
    },
    {
      provider: { snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    },
  );
}, 10_000);

test('typeAndroid reports clear error when unicode input is unsupported', async () => {
  await withFakeAdb(
    (args) => {
      if (args.join(' ').startsWith('shell cmd clipboard set text')) {
        return 'No shell command implementation.';
      }
      if (isShellInput(args, 'text')) {
        return {
          stderr: "Exception occurred while executing 'text':\njava.lang.NullPointerException\n",
          exitCode: 255,
        };
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ device }) => {
      await assertRejectsAppError(() => typeAndroid(device, '很'), {
        code: 'COMMAND_FAILED',
        message: /provider-native text injection/i,
      });
    },
  );
});

test('fillAndroid tolerates delayed React Native text verification', async () => {
  // The first hierarchy dump reports a stale truncated value (React Native
  // committing late); the later stability dumps report the real text.
  let state = '';
  let dumpCount = 0;
  await withFakeAdb(
    (args) => {
      const helperResponse = snapshotHelperResponse(args, () => {
        dumpCount += 1;
        return dumpCount === 1 ? 'sent the updat' : state;
      });
      if (helperResponse !== undefined) return helperResponse;
      if (isShellInput(args, 'tap')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_MOVE_END')) return undefined;
      if (isShellKeyevent(args, 'KEYCODE_DEL')) {
        state = '';
        return undefined;
      }
      if (isShellInput(args, 'text')) {
        state += (args[3] ?? '').replace(/%s/g, ' ');
        return undefined;
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ device }) => {
      await fillAndroid(device, 10, 10, 'sent the update');
    },
    {
      provider: { snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT },
    },
  );
}, 10_000);

test('typeAndroid reports clear error when unicode input is unsupported', async () => {
  await withFakeAdb(
    (args) => {
      if (args.join(' ').startsWith('shell cmd clipboard set text')) {
        return 'No shell command implementation.';
      }
      if (isShellInput(args, 'text')) {
        return {
          stderr: "Exception occurred while executing 'text':\njava.lang.NullPointerException\n",
          exitCode: 255,
        };
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ device }) => {
      await assertRejectsAppError(() => typeAndroid(device, '很'), {
        code: 'COMMAND_FAILED',
        message: /provider-native text injection/i,
      });
    },
  );
});

test('typeAndroid reports clear error when unicode input is unsupported', async () => {
  await withFakeAdb(
    (args) => {
      if (args.join(' ').startsWith('shell cmd clipboard set text')) {
        return 'No shell command implementation.';
      }
      if (isShellInput(args, 'text')) {
        return {
          stderr: "Exception occurred while executing 'text':\njava.lang.NullPointerException\n",
          exitCode: 255,
        };
      }
      return { stderr: `unexpected args: ${args.join(' ')}`, exitCode: 1 };
    },
    async ({ device }) => {
      await assertRejectsAppError(() => typeAndroid(device, '很'), {
        code: 'COMMAND_FAILED',
        message: /provider-native text injection/i,
      });
    },
  );
});

function shellInputTextCalls(calls: string[][]): string[][] {
  return calls.filter((args) => isShellInput(args, 'text'));
}

/**
 * Answers the snapshot-helper version probe and `am instrument` capture with a
 * one-EditText hierarchy holding `resolveText()`, mirroring the PATH-stub
 * helper script this file used before provider injection. Returns undefined for
 * every other invocation so the caller's script keeps handling input actions.
 */
function snapshotHelperResponse(args: string[], resolveText: () => string): string | undefined {
  return androidSnapshotHelperScriptResponse(
    args,
    () =>
      `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node class="android.widget.EditText" text="${resolveText()}" focused="true" bounds="[0,0][200,100]"/></hierarchy>`,
  );
}
