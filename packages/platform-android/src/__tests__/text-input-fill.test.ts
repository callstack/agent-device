import { test } from 'vitest';
import './test-utils/android-host-test-setup.ts';
import assert from 'node:assert/strict';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import {
  ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
  createAndroidSnapshotHelperExecutor,
} from './test-utils/android-snapshot-helper.ts';
import { AppError } from '@agent-device/kernel/errors';
import { fillAndroid, typeAndroid } from '../text-input.ts';
import { withAndroidAdbProvider, type AndroidAdbExecutor } from '../adb-executor.ts';
import {
  androidFillFailureDetails,
  androidFillFailureMessage,
  readAndroidTextAtPointInHierarchy,
  verifyAndroidFilledTextInHierarchy,
} from '../fill-verification.ts';
import { resetAndroidSnapshotHelperSessions } from '../snapshot-helper-session-lifecycle.ts';
import {
  createPersistentSnapshotHelperProvider,
  isAndroidHelperForwardRemoval,
  type FakeAndroidProcess,
} from './snapshot-helper-session.fixtures.ts';

test('fillAndroid reports when the IME captures input instead of the app field', async () => {
  const calls: string[][] = [];
  let imeText = '';
  let snapshotCount = 0;
  await withFillAdb(
    async (args) => {
      calls.push(args);
      if (isTextInput(args)) imeText = args[3] ?? '';
      return adbResult('');
    },
    () => {
      snapshotCount += 1;
      return imeCaptureHierarchy(imeText);
    },
    async () => {
      await assert.rejects(
        () => fillAndroid(ANDROID_EMULATOR, 10, 10, 'chips'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /captured by the active keyboard/i);
          assert.equal(error.details?.failureReason, 'ime_capture');
          assert.equal(inputDetails(error, 'actualInput')?.resourceId, IME_RESOURCE_ID);
          assert.equal(
            inputDetails(error, 'targetInput')?.resourceId,
            'com.example.shop:id/search',
          );
          return true;
        },
      );
    },
  );

  assert.equal(
    calls.some((args) => args.join('\n') === 'shell\ncmd\nclipboard\nset\ntext'),
    false,
  );
  assert.equal(
    calls.some((args) => args.join('\n') === 'shell\ninput\nkeyevent\nKEYCODE_PASTE'),
    false,
  );
  assert.equal(calls.filter(isTextInput).length, 1);
  assert.equal(snapshotCount, 2);
});

test('fillAndroid detects unknown active IME package during verification', async () => {
  const calls: string[][] = [];
  let imeText = '';
  let snapshotCount = 0;
  await withFillAdb(
    async (args) => {
      calls.push(args);
      if (args.join('\n') === 'shell\ndumpsys\ninput_method') {
        return adbResult(vendorImeWithAppFocusInputMethodDump());
      }
      if (isTextInput(args)) imeText = args[3] ?? '';
      return adbResult('');
    },
    () => {
      snapshotCount += 1;
      return vendorImeCaptureHierarchy(imeText);
    },
    async () => {
      await assert.rejects(
        () => fillAndroid(ANDROID_EMULATOR, 10, 10, 'chips'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.equal(error.details?.failureReason, 'ime_capture');
          assert.equal(inputDetails(error, 'actualInput')?.packageName, 'com.vendor.keyboard');
          assert.equal(
            inputDetails(error, 'targetInput')?.resourceId,
            'com.example.shop:id/search',
          );
          return true;
        },
      );
    },
  );

  assert.equal(calls.filter(isTextInput).length, 1);
  assert.equal(snapshotCount, 2);
});

// The ASCII limit belongs to the shell writer, so it is enforced only once the active input method
// has been read and turned out not to be the helper — never before that read.

test('typeAndroid rejects unicode text once a third-party IME puts it on the shell path', async () => {
  const calls: string[][] = [];
  await withFillAdb(
    async (args) => {
      calls.push(args);
      if (args.join('\n') === 'shell\ndumpsys\ninput_method') {
        return adbResult(vendorImeWithAppFocusInputMethodDump());
      }
      return adbResult('');
    },
    async () => {
      await assert.rejects(
        () => typeAndroid(ANDROID_EMULATOR, '很 ☝ 😀'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /provider-native text injection/i);
          assert.equal(error.details?.backend, 'adb-shell');
          return true;
        },
      );
    },
  );

  assert.equal(calls.filter(isTextInput).length, 0);
});

test('fillAndroid rejects unicode text once a third-party IME puts it on the shell path', async () => {
  const calls: string[][] = [];
  await withFillAdb(
    async (args) => {
      calls.push(args);
      if (args.join('\n') === 'shell\ndumpsys\ninput_method') {
        return adbResult(vendorImeWithAppFocusInputMethodDump());
      }
      return adbResult('');
    },
    () => androidInputXml({ text: 'Search Products' }),
    async () => {
      await assert.rejects(
        () => fillAndroid(ANDROID_EMULATOR, 10, 10, '很 ☝ 😀'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /provider-native text injection/i);
          assert.equal(error.details?.backend, 'adb-shell');
          return true;
        },
      );
    },
  );

  assert.equal(calls.filter(isTextInput).length, 0);
  assert.equal(
    calls.some(isDeleteKey),
    false,
    'refusing the text must not have cleared the field first',
  );
});

test('typeAndroid refuses shell fallback when the IME owns input focus', async () => {
  const calls: string[][] = [];
  await withFillAdb(
    async (args) => {
      calls.push(args);
      if (args.join('\n') === 'shell\ndumpsys\ninput_method') {
        return adbResult(imeOwnedInputMethodDump());
      }
      if (isTextInput(args)) throw new Error('input text should not run');
      return adbResult('');
    },
    async () => {
      await assert.rejects(
        () => typeAndroid(ANDROID_EMULATOR, 'filed the expense'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /KEYBOARD_OVERLAY_BLOCKING/);
          assert.equal(error.details?.failureReason, 'ime_capture');
          assert.equal(error.details?.inputOwner, 'ime');
          assert.equal(error.details?.inputMethodPackage, 'com.google.android.inputmethod.latin');
          return true;
        },
      );
    },
  );

  assert.equal(calls.filter(isTextInput).length, 0);
});

test('fillAndroid refuses shell fallback after focus when the IME owns input focus', async () => {
  const calls: string[][] = [];
  await withFillAdb(
    async (args) => {
      calls.push(args);
      if (args.join('\n') === 'shell\ndumpsys\ninput_method') {
        return adbResult(imeOwnedInputMethodDump());
      }
      if (isTextInput(args)) throw new Error('input text should not run');
      return adbResult('');
    },
    async () => {
      await assert.rejects(
        () => fillAndroid(ANDROID_EMULATOR, 10, 10, 'filed the expense'),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /KEYBOARD_OVERLAY_BLOCKING/);
          assert.equal(error.details?.failureReason, 'ime_capture');
          assert.equal(error.details?.action, 'fill');
          return true;
        },
      );
    },
  );

  assert.equal(
    calls.some((args) => args.join('\n') === 'shell\ninput\ntap\n10\n10'),
    true,
  );
  assert.equal(calls.filter(isDeleteKey).length, 0);
  assert.equal(calls.filter(isTextInput).length, 0);
});

test('fillAndroid delegates target replacement to provider-native text injection', async () => {
  const calls: unknown[] = [];
  let value = '';
  await withAndroidAdbProvider(
    {
      snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
      exec: createAndroidSnapshotHelperExecutor({
        exec: async (args) => {
          throw new Error(`unexpected adb call: ${args.join(' ')}`);
        },
        captureXml: () => androidInputXml({ text: value }),
      }),
      text: async (request) => {
        calls.push(request);
        value = request.text;
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await fillAndroid(ANDROID_EMULATOR, 10, 10, 'filed the expense');
    },
  );

  assert.deepEqual(calls, [
    {
      action: 'fill',
      target: { x: 10, y: 10 },
      text: 'filed the expense',
      delayMs: 0,
    },
  ]);
});

test('fillAndroid returns target-bound unconfirmed evidence when an input mask reformats text', async () => {
  const calls: unknown[] = [];
  let value = '12 123 4567';
  await withAndroidAdbProvider(
    {
      snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
      exec: createAndroidSnapshotHelperExecutor({
        exec: async (args) => {
          throw new Error(`unexpected adb call: ${args.join(' ')}`);
        },
        captureXml: () => phoneInputXml(value),
      }),
      text: async (request) => {
        calls.push(request);
        value = '05 012 3456';
      },
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      const result = await fillAndroid(ANDROID_EMULATOR, 100, 50, '0501234567');

      assert.deepEqual(result, {
        verification: 'unconfirmed',
        requested: '0501234567',
        before: '12 123 4567',
        after: '05 012 3456',
        target: {
          resourceId: 'com.example:id/phone',
          className: 'android.widget.EditText',
          packageName: 'com.example',
          rect: { x: 0, y: 0, width: 200, height: 100 },
        },
      });
    },
  );

  assert.equal(calls.length, 1, 'an ambiguous committed fill must not be repeated');
});

test('fillAndroid waits for settled app text before reporting success', async () => {
  let typed = '';
  let dumpCount = 0;
  let inputCount = 0;
  await withFillAdb(
    async (args) => {
      if (isDeleteKey(args)) typed = '';
      if (isTextInput(args)) {
        inputCount += 1;
        typed += args[3] ?? '';
      }
      return adbResult('');
    },
    () => {
      dumpCount += 1;
      const visibleText = dumpCount <= 1 ? typed : dumpCount <= 3 ? 'file' : 'filed';
      return androidInputXml({ text: visibleText });
    },
    async () => {
      await fillAndroid(ANDROID_EMULATOR, 10, 10, 'filed');
    },
  );

  assert.equal(inputCount, 1);
  assert.ok(dumpCount >= 4);
});

test('verifyAndroidFilledTextInHierarchy accepts matching-length masked password verification', () => {
  const verification = verifyAndroidFilledTextInHierarchy(
    passwordHierarchy(maskBullets('Test@123')),
    10,
    10,
    'Test@123',
  );

  assert.equal(verification.ok, true);
  assert.equal(verification.masked, true);
});

test('verifyAndroidFilledTextInHierarchy accepts Android sentence autocapitalization', () => {
  const verification = verifyAndroidFilledTextInHierarchy(
    androidInputXml({ text: 'Sent the update' }),
    10,
    10,
    'sent the update',
  );

  assert.equal(verification.ok, true);
});

// `fill <target> ""` is the clear-field primitive (#2063). A cleared EditText carries no `text`
// attribute at all, so the dump reads back as null while the expectation is "": without an
// explicit empty rule the clear succeeds on the device and is still reported as text_mismatch.
test('verifyAndroidFilledTextInHierarchy accepts a cleared field for an empty expectation', () => {
  const clearedByAttribute = verifyAndroidFilledTextInHierarchy(
    androidInputXml({ text: '' }),
    10,
    10,
    '',
  );
  assert.equal(clearedByAttribute.ok, true);

  const clearedWithoutAttribute = verifyAndroidFilledTextInHierarchy(
    '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" focused="true" bounds="[0,0][200,100]"/></hierarchy>',
    10,
    10,
    '',
  );
  assert.equal(clearedWithoutAttribute.ok, true);
});

test('verifyAndroidFilledTextInHierarchy refuses an empty expectation when no input is observed at all', () => {
  // `actual` is null both for a cleared field and for NO field: a wrong point or lost focus
  // must not satisfy the empty expectation, or three such samples become a stable success for
  // a clear that never touched an app input.
  const noInputAnywhere = verifyAndroidFilledTextInHierarchy(
    '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.FrameLayout" bounds="[0,0][1080,1920]"/></hierarchy>',
    10,
    10,
    '',
  );
  assert.equal(noInputAnywhere.ok, false);
  assert.equal(noInputAnywhere.actualInput, null);

  const inputElsewhere = verifyAndroidFilledTextInHierarchy(
    '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" bounds="[500,500][700,600]"/></hierarchy>',
    10,
    10,
    '',
  );
  assert.equal(inputElsewhere.ok, false);
});

// Live Pixel 9 emulator (Settings search, adb-shell channel): a CLEARED EditText dumps its hint
// as `text` ("Search settings"), because getText() returns the hint for an empty field on
// modern Android. The helper's hint-showing fact is the only way to tell that apart from a
// field whose VALUE equals the hint string.
test('verifyAndroidFilledTextInHierarchy accepts hint-only text for an empty expectation', () => {
  const hintShowing = verifyAndroidFilledTextInHierarchy(
    '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="Search settings" hint-showing="true" focused="true" bounds="[0,0][200,100]"/></hierarchy>',
    10,
    10,
    '',
  );
  assert.equal(hintShowing.ok, true);

  // Without the fact, identical text is a real value and the clear must NOT verify.
  const valueEqualsHint = verifyAndroidFilledTextInHierarchy(
    androidInputXml({ text: 'Search settings' }),
    10,
    10,
    '',
  );
  assert.equal(valueEqualsHint.ok, false);
});

test('verifyAndroidFilledTextInHierarchy treats hint-only text as an empty value for a non-empty expectation', () => {
  const verification = verifyAndroidFilledTextInHierarchy(
    '<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="Search settings" hint-showing="true" focused="true" bounds="[0,0][200,100]"/></hierarchy>',
    10,
    10,
    'battery saver',
  );
  assert.equal(verification.ok, false);
  assert.equal(verification.actual, 'Search settings');
});

test('verifyAndroidFilledTextInHierarchy still refuses a non-empty field for an empty expectation', () => {
  const verification = verifyAndroidFilledTextInHierarchy(
    androidInputXml({ text: 'still here' }),
    10,
    10,
    '',
  );

  assert.equal(verification.ok, false);
  assert.equal(verification.actual, 'still here');
});

test('verifyAndroidFilledTextInHierarchy rejects near-complete prefixes', () => {
  const verification = verifyAndroidFilledTextInHierarchy(
    androidInputXml({ text: 'filed the expens' }),
    10,
    10,
    'filed the expense',
  );

  assert.equal(verification.ok, false);
  assert.equal(verification.actual, 'filed the expens');
});

test('verifyAndroidFilledTextInHierarchy does not treat inputmethod substring as IME ownership', () => {
  const verification = verifyAndroidFilledTextInHierarchy(
    appPackageWithInputMethodSubstringHierarchy(),
    10,
    10,
    'chips',
  );

  assert.equal(verification.ok, true);
  assert.notEqual(verification.reason, 'ime_capture');
  assert.equal(verification.actualInput?.packageName, 'com.example.inputmethod.demo');
  assert.equal(verification.actualInput?.inputMethodOwned, false);
});

test('verifyAndroidFilledTextInHierarchy treats active unknown IME package as IME ownership', () => {
  const verification = verifyAndroidFilledTextInHierarchy(
    vendorImeCaptureHierarchy('chips'),
    10,
    10,
    'chips',
    { activeInputMethodPackage: 'com.vendor.keyboard' },
  );

  assert.equal(verification.ok, false);
  assert.equal(verification.reason, 'ime_capture');
  assert.equal(verification.actualInput?.packageName, 'com.vendor.keyboard');
  assert.equal(verification.actualInput?.inputMethodOwned, true);
});

test('verifyAndroidFilledTextInHierarchy rejects reverse sentence autocapitalization mismatch', () => {
  const verification = verifyAndroidFilledTextInHierarchy(
    androidInputXml({ text: 'john' }),
    10,
    10,
    'John',
  );

  assert.equal(verification.ok, false);
});

test('verifyAndroidFilledTextInHierarchy does not ignore broader case mismatches', () => {
  const verification = verifyAndroidFilledTextInHierarchy(
    androidInputXml({ text: 'SENT THE UPDATE' }),
    10,
    10,
    'sent the update',
  );

  assert.equal(verification.ok, false);
});

// The delete burst used to be sized from the INCOMING text, so the empty clear (#2063) sent the
// 12/24-delete minimums and could never empty a field longer than 36 characters — leaving residue
// after reporting failure. The clear must be sized from the value being removed.
test('fillAndroid sizes the empty clear from the field content, not the empty text', async () => {
  let value = 'a'.repeat(70);
  let deletes = 0;
  await withFillAdb(
    async (args) => {
      if (args[0] === 'shell' && args[1] === 'input' && args[2] === 'keyevent') {
        const count = args.filter((arg) => arg === 'KEYCODE_DEL').length;
        deletes += count;
        value = value.slice(0, Math.max(0, value.length - count));
      }
      return adbResult('');
    },
    () => androidInputXml({ text: value }),
    async () => {
      await fillAndroid(ANDROID_EMULATOR, 10, 10, '');
    },
  );
  assert.equal(value, '');
  assert.ok(deletes >= 70, `expected the clear to cover the 70-char value, sent ${deletes}`);
});

// A masked value only ever compares by length, and the empty expectation (#2063) accepts an
// observed masked node with no dump text: a masked field WITH content dumps its bullet run.
// Matches iOS, where clearing a secure field succeeds unverified instead of failing after the
// clear worked.
test('verifyAndroidFilledTextInHierarchy accepts a cleared masked field for an empty expectation', () => {
  const cleared = verifyAndroidFilledTextInHierarchy(passwordHierarchy(''), 10, 10, '');
  assert.equal(cleared.ok, true);
  assert.equal(cleared.masked, true);

  const residue = verifyAndroidFilledTextInHierarchy(
    passwordHierarchy(maskBullets('Test@123')),
    10,
    10,
    '',
  );
  assert.equal(residue.ok, false);
  assert.equal(residue.reason, 'masked_unverified');
});

test('fillAndroid accepts matching-length masked password verification', async () => {
  let typed = '';
  await withFillAdb(
    async (args) => {
      if (isDeleteKey(args)) typed = '';
      if (isTextInput(args)) typed = args[3] ?? '';
      return adbResult('');
    },
    () => passwordHierarchy(maskBullets(typed)),
    async () => {
      await fillAndroid(ANDROID_EMULATOR, 10, 10, 'Test@123');
    },
  );
});

test('verifyAndroidFilledTextInHierarchy redacts masked password values on wrong-length failure', () => {
  const exposedPasswordValue = 'secret-value';
  const verification = verifyAndroidFilledTextInHierarchy(
    passwordHierarchy(exposedPasswordValue),
    10,
    10,
    'Test@123',
  );

  assert.equal(verification.ok, false);
  assertMaskedPasswordFailure(
    androidFillFailureMessage(verification),
    androidFillFailureDetails('Test@123', verification),
    exposedPasswordValue,
  );
});

test('readAndroidTextAtPointInHierarchy reads the EditText under the requested point', () => {
  const hierarchy = `<?xml version="1.0" encoding="UTF-8"?><hierarchy>
<node package="com.example" class="android.widget.EditText" text="Ada Lovelace" resource-id="com.example:id/field-name" focused="false" bounds="[0,0][200,100]"/>
<node package="com.example" class="android.widget.EditText" text="fallback@example.com" resource-id="com.example:id/field-email" focused="true" bounds="[0,200][200,300]"/>
</hierarchy>`;

  assert.equal(readAndroidTextAtPointInHierarchy(hierarchy, 100, 50), 'Ada Lovelace');
  assert.equal(readAndroidTextAtPointInHierarchy(hierarchy, 100, 250), 'fallback@example.com');
});

test('fillAndroid runs the whole attempt on one warm daemon-session helper', async () => {
  const calls: string[][] = [];
  const spawnArgs: string[][] = [];
  const processes: FakeAndroidProcess[] = [];
  let typed = '';
  let captureCount = 0;
  const provider = createPersistentSnapshotHelperProvider({
    calls,
    spawnArgs,
    processes,
    sessionXml: () => {
      captureCount += 1;
      return androidInputXml({ text: typed });
    },
  });

  await resetAndroidSnapshotHelperSessions();
  await withAndroidAdbProvider(
    {
      ...provider,
      exec: async (args, options) => {
        if (isDeleteKey(args)) typed = '';
        if (isTextInput(args)) typed = args[3] ?? '';
        if (args[0] === 'shell' && args[1] !== 'am') return adbResult('');
        return await provider.exec(args, options);
      },
      snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    },
    { serial: ANDROID_EMULATOR.id },
    async () => {
      await fillAndroid(ANDROID_EMULATOR, 10, 10, 'chips', 0, {
        helperSessionScope: 'daemon-session',
      });
    },
  );

  // One pre-action target read plus the three settling samples.
  assert.equal(captureCount, 4);
  assert.equal(spawnArgs.length, 1);
  assert.equal(calls.filter(isAndroidHelperForwardRemoval).length, 0);
  assert.equal(processes[0]?.exitCode, null);
  await resetAndroidSnapshotHelperSessions();
});

const IME_RESOURCE_ID = 'com.google.android.inputmethod.latin:id/0_resource_name_obfuscated';

async function withFillAdb(exec: AndroidAdbExecutor, fn: () => Promise<void>): Promise<void>;
async function withFillAdb(
  exec: AndroidAdbExecutor,
  captureXml: () => string | Promise<string>,
  fn: () => Promise<void>,
): Promise<void>;
async function withFillAdb(
  exec: AndroidAdbExecutor,
  captureXmlOrFn: (() => string | Promise<string>) | (() => Promise<void>),
  maybeFn?: () => Promise<void>,
): Promise<void> {
  const captureXml = maybeFn
    ? (captureXmlOrFn as () => string | Promise<string>)
    : () => {
        throw new Error('snapshot helper capture was not expected');
      };
  const fn = maybeFn ?? (captureXmlOrFn as () => Promise<void>);
  await withAndroidAdbProvider(
    {
      exec: createAndroidSnapshotHelperExecutor({ exec, captureXml }),
      snapshotHelperArtifact: ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT,
    },
    { serial: ANDROID_EMULATOR.id },
    fn,
  );
}

function adbResult(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 };
}

function isTextInput(args: string[]): boolean {
  return args[0] === 'shell' && args[1] === 'input' && args[2] === 'text';
}

function isDeleteKey(args: string[]): boolean {
  return args.join('\n') === 'shell\ninput\nkeyevent\nKEYCODE_DEL';
}

function inputDetails(error: AppError, key: 'actualInput' | 'targetInput') {
  return error.details?.[key] as Record<string, unknown> | null | undefined;
}

function imeOwnedInputMethodDump(): string {
  return [
    'mInputShown=true',
    'mCurMethodId=com.google.android.inputmethod.latin/.LatinIME',
    'packageName=com.google.android.inputmethod.latin',
    `resourceId=${IME_RESOURCE_ID}`,
    'inputType=0x1',
  ].join('\n');
}

function vendorImeWithAppFocusInputMethodDump(): string {
  return [
    'mInputShown=true',
    'mCurMethodId=com.vendor.keyboard/.VendorIme',
    'packageName=com.example.shop',
    'resourceId=com.example.shop:id/search',
    'inputType=0x1',
  ].join('\n');
}

function assertMaskedPasswordFailure(
  message: string,
  details: Record<string, unknown>,
  exposedPasswordValue: string,
): void {
  assert.match(message, /could not confirm masked text value/i);
  assert.equal(details.failureReason, 'masked_unverified');
  assert.equal(details.masked, true);
  assert.equal(details.expected, undefined);
  assert.equal(details.expectedLength, 8);
  assert.equal(details.actual, null);
  assert.equal(details.actualLength, exposedPasswordValue.length);
  assert.equal(detailsInput(details, 'actualInput')?.text, null);
  assert.equal(detailsInput(details, 'actualInput')?.textRedacted, true);
  assert.equal(detailsInput(details, 'targetInput')?.text, null);
  assert.doesNotMatch(JSON.stringify(details), /Test@123|secret-value/);
}

function detailsInput(details: Record<string, unknown>, key: 'actualInput' | 'targetInput') {
  return details[key] as Record<string, unknown> | null | undefined;
}

function imeCaptureHierarchy(imeText: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy>
<node package="com.example.shop" class="android.widget.EditText" text="Search Products" resource-id="com.example.shop:id/search" focused="false" bounds="[0,0][300,100]"/>
<node package="com.google.android.inputmethod.latin" class="android.widget.EditText" text="${imeText}" resource-id="${IME_RESOURCE_ID}" focused="true" bounds="[0,700][300,800]"/>
</hierarchy>`;
}

function vendorImeCaptureHierarchy(imeText: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy>
<node package="com.example.shop" class="android.widget.EditText" text="Search Products" resource-id="com.example.shop:id/search" focused="false" bounds="[0,0][300,100]"/>
<node package="com.vendor.keyboard" class="android.widget.EditText" text="${imeText}" resource-id="com.vendor.keyboard:id/composing" focused="true" bounds="[0,700][300,800]"/>
</hierarchy>`;
}

function passwordHierarchy(mask: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="${mask}" password="true" focused="true" bounds="[0,0][200,100]"/></hierarchy>`;
}

function androidInputXml(options: { text: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="${options.text}" focused="true" bounds="[0,0][200,100]"/></hierarchy>`;
}

function phoneInputXml(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy><node package="com.example" class="android.widget.EditText" text="${text}" resource-id="com.example:id/phone" focused="true" bounds="[0,0][200,100]"/></hierarchy>`;
}

function appPackageWithInputMethodSubstringHierarchy(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><hierarchy>
<node package="com.example.shop" class="android.widget.EditText" text="Search Products" resource-id="com.example.shop:id/search" focused="false" bounds="[0,0][300,100]"/>
<node package="com.example.inputmethod.demo" class="android.widget.EditText" text="chips" resource-id="com.example.inputmethod.demo:id/search" focused="true" bounds="[0,700][300,800]"/>
</hierarchy>`;
}

function maskBullets(value: string): string {
  return Array.from(value)
    .map(() => '&#8226;')
    .join('');
}
