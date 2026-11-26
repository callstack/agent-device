import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { bindAndroidAdbHostStub } from '../adb-host.fixtures.ts';
import {
  androidRevokedPermissionWarning,
  parseAndroidPermissionRequest,
  setAndroidPermission,
} from '../settings-permission.ts';
import {
  androidPmBatchTimeoutMs,
  buildAndroidPmBatchScript,
  chunkAndroidPmBatch,
  parseAndroidPmBatchOutput,
} from '../settings-permission-batch.ts';
import { bindAndroidAdbTestHost } from './test-utils/android-host-test-setup.ts';
import { ANDROID_EMULATOR } from './test-utils/device-fixtures.ts';
import { withFakeAdb } from './test-utils/fake-adb.ts';
import {
  isAndroidPmBatchShellArgs,
  runFakeAndroidPmBatchInSh,
  type FakePmReply,
} from './test-utils/fake-android-pm-shell.ts';

const DUMPSYS = 'shell dumpsys package com.example.app';

function makeDumpsys(
  requested: readonly string[],
  runtime: ReadonlyArray<readonly [string, boolean]> = [],
  userId = 0,
): string {
  return [
    'Packages:',
    '  Package [com.example.app] (abc):',
    '    requested permissions:',
    ...requested.map((id) => `      ${id}`),
    `    User ${userId}: ceDataInode=0 installed=true`,
    '      runtime permissions:',
    ...runtime.map(([id, granted]) => `        ${id}: granted=${granted}`),
    'Queries:',
  ].join('\n');
}

function makeBatchFake(
  dumpsys: string,
  pmReplies: Readonly<Record<string, FakePmReply>> = {},
  extra?: (args: string[], options?: { timeoutMs?: number }) => unknown,
) {
  const pmCalls: string[][] = [];
  const batchOptions: Array<{ timeoutMs?: number }> = [];
  const script = (args: string[], options?: { timeoutMs?: number }) => {
    if (extra) {
      const override = extra(args, options);
      if (override !== undefined) return override as never;
    }
    if (isAndroidPmBatchShellArgs(args)) {
      batchOptions.push({ timeoutMs: options?.timeoutMs });
      return runFakeAndroidPmBatchInSh(args[1]!, pmReplies, pmCalls);
    }
    const flat = args.join(' ');
    if (flat === DUMPSYS) return dumpsys;
    if (flat === 'shell getprop ro.build.version.sdk') return '36';
    return undefined;
  };
  return {
    script,
    pmCalls,
    batchOptions,
    flatPmCalls: () => pmCalls.map((argv) => ['shell', 'pm', ...argv].join(' ')),
  };
}

test('grant all batches contiguous pm units into one adb shell call and preserves order and warnings', async () => {
  const requested = [
    'android.permission.INTERNET',
    'android.permission.CAMERA',
    'android.permission.WAKE_LOCK',
    'android.permission.RECORD_AUDIO',
    'android.permission.WRITE_SETTINGS',
  ];
  const fake = makeBatchFake(makeDumpsys(requested), {
    'shell pm grant --user 10 com.example.app android.permission.INTERNET': {
      stderr:
        "Exception occurred while executing 'grant':\njava.lang.SecurityException: INTERNET is NOT A CHANGEABLE PERMISSION type\n\tat com.android.server.pm.Service.grant(Service.java:1)\n",
      exitCode: 1,
    },
    'shell pm grant --user 10 com.example.app android.permission.WAKE_LOCK': {
      stderr: 'Permission android.permission.WAKE_LOCK is not a runtime permission',
      exitCode: 1,
    },
    'shell pm grant --user 10 com.example.app android.permission.WRITE_SETTINGS': {
      stderr: 'SecurityException: Permission is MANAGED BY ROLE',
      exitCode: 1,
    },
  });

  await withFakeAdb(fake.script, async ({ calls, device }) => {
    const result = await setAndroidPermission(
      device,
      'com.example.app',
      parseAndroidPermissionRequest('grant', { permissionTarget: 'all' }),
      10,
    );
    assert.deepEqual(result, {
      permission: 'all',
      permissions: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'],
      warnings: [
        "Skipped android.permission.INTERNET for com.example.app: Exception occurred while executing 'grant': java.lang.SecurityException: INTERNET is NOT A CHANGEABLE PERMISSION type",
        'Skipped android.permission.WAKE_LOCK for com.example.app: Permission android.permission.WAKE_LOCK is not a runtime permission',
        'Skipped android.permission.WRITE_SETTINGS for com.example.app: SecurityException: Permission is MANAGED BY ROLE',
      ],
    });
    // One dumpsys + one batched pm shell call (not 5 separate pm calls).
    assert.equal(calls.length, 2);
    assert.equal(fake.batchOptions[0]?.timeoutMs, androidPmBatchTimeoutMs(5, false));
    assert.deepEqual(fake.flatPmCalls(), [
      'shell pm grant --user 10 com.example.app android.permission.INTERNET',
      'shell pm grant --user 10 com.example.app android.permission.CAMERA',
      'shell pm grant --user 10 com.example.app android.permission.WAKE_LOCK',
      'shell pm grant --user 10 com.example.app android.permission.RECORD_AUDIO',
      'shell pm grant --user 10 com.example.app android.permission.WRITE_SETTINGS',
    ]);
  });
});

test('reset all clears user-set and user-fixed flags inside the batch only for applied permissions', async () => {
  const requested = [
    'android.permission.INTERNET',
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
  ];
  const fake = makeBatchFake(
    makeDumpsys(requested, [
      ['android.permission.CAMERA', true],
      ['android.permission.RECORD_AUDIO', false],
    ]),
    {
      'shell pm revoke --user 0 com.example.app android.permission.INTERNET': {
        stderr: 'SecurityException: INTERNET is not a changeable permission type',
        exitCode: 1,
      },
    },
  );

  await withFakeAdb(fake.script, async ({ calls, device }) => {
    const result = await setAndroidPermission(
      device,
      'com.example.app',
      parseAndroidPermissionRequest('reset', { permissionTarget: 'all' }),
      0,
    );
    assert.deepEqual(result, {
      permission: 'all',
      permissions: ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'],
      warnings: [
        'Skipped android.permission.INTERNET for com.example.app: SecurityException: INTERNET is not a changeable permission type',
        androidRevokedPermissionWarning('com.example.app', 'android.permission.CAMERA', 'granted')!,
      ],
    });
    // One dumpsys + one batched shell call (revokes + flag clears all inside that one call).
    assert.equal(calls.length, 2);
    assert.equal(fake.batchOptions[0]?.timeoutMs, androidPmBatchTimeoutMs(3, true));
    assert.deepEqual(fake.flatPmCalls(), [
      'shell pm revoke --user 0 com.example.app android.permission.INTERNET',
      'shell pm revoke --user 0 com.example.app android.permission.CAMERA',
      'shell pm clear-permission-flags --user 0 com.example.app android.permission.CAMERA user-set',
      'shell pm clear-permission-flags --user 0 com.example.app android.permission.CAMERA user-fixed',
      'shell pm revoke --user 0 com.example.app android.permission.RECORD_AUDIO',
      'shell pm clear-permission-flags --user 0 com.example.app android.permission.RECORD_AUDIO user-set',
      'shell pm clear-permission-flags --user 0 com.example.app android.permission.RECORD_AUDIO user-fixed',
    ]);
  });
});

test('deny all and reset all interleave photos and notifications in exact declared order', async () => {
  const requested = [
    'android.permission.INTERNET',
    'android.permission.CAMERA',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
  ];
  const runtime = [
    ['android.permission.CAMERA', true],
    ['android.permission.POST_NOTIFICATIONS', true],
    ['android.permission.RECORD_AUDIO', false],
    ['android.permission.READ_MEDIA_IMAGES', true],
    ['android.permission.ACCESS_FINE_LOCATION', false],
    ['android.permission.ACCESS_COARSE_LOCATION', true],
  ] as const;

  const fake = makeBatchFake(makeDumpsys(requested, runtime), {
    'shell pm revoke --user 0 com.example.app android.permission.INTERNET': {
      stderr: 'SecurityException: INTERNET is not a changeable permission type',
      exitCode: 1,
    },
  });

  await withFakeAdb(fake.script, async ({ calls, device }) => {
    const result = await setAndroidPermission(
      device,
      'com.example.app',
      parseAndroidPermissionRequest('deny', { permissionTarget: 'all' }),
      0,
    );
    assert.deepEqual(result, {
      permission: 'all',
      permissions: [
        'android.permission.CAMERA',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
      ],
      warnings: [
        'Skipped android.permission.INTERNET for com.example.app: SecurityException: INTERNET is not a changeable permission type',
        androidRevokedPermissionWarning('com.example.app', 'android.permission.CAMERA', 'granted')!,
        androidRevokedPermissionWarning(
          'com.example.app',
          'android.permission.POST_NOTIFICATIONS',
          'granted',
        )!,
        androidRevokedPermissionWarning(
          'com.example.app',
          'android.permission.READ_MEDIA_IMAGES',
          'granted',
        )!,
        androidRevokedPermissionWarning(
          'com.example.app',
          'android.permission.ACCESS_COARSE_LOCATION',
          'granted',
        )!,
      ],
    });
    const flatCalls = calls.map((args) => args.join(' '));
    // Verify notifications appops and photos probe both ran in exact sequence between pm batches.
    const appopsIdx = flatCalls.indexOf(
      'shell appops set --user 0 com.example.app POST_NOTIFICATION deny',
    );
    const sdkIdx = flatCalls.indexOf('shell getprop ro.build.version.sdk');
    const photosIdx = flatCalls.indexOf(
      'shell pm revoke --user 0 com.example.app android.permission.READ_MEDIA_IMAGES',
    );
    assert.ok(appopsIdx > 0 && sdkIdx > appopsIdx && photosIdx > sdkIdx, flatCalls.join(' | '));
  });
});

test('hard failure mid-batch preserves exact stdout/stderr/exitCode and stops before subsequent permissions and units', async () => {
  const requested = [
    'android.permission.INTERNET',
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.POST_NOTIFICATIONS',
  ];
  const fake = makeBatchFake(makeDumpsys(requested), {
    'shell pm grant --user 0 com.example.app android.permission.INTERNET': {
      stderr: 'SecurityException: INTERNET is not a changeable permission type',
      exitCode: 1,
    },
    'shell pm grant --user 0 com.example.app android.permission.CAMERA': {
      stdout: 'partial-out\n',
      stderr: 'Failure: permission service crashed\n',
      exitCode: 42,
    },
  });

  await withFakeAdb(fake.script, async ({ calls, device }) => {
    await assert.rejects(
      () =>
        setAndroidPermission(
          device,
          'com.example.app',
          parseAndroidPermissionRequest('grant', { permissionTarget: 'all' }),
          0,
        ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.equal(
          error.message,
          'Failed to grant Android permission android.permission.CAMERA for com.example.app',
        );
        assert.equal(error.details?.exitCode, 42);
        assert.equal(error.details?.stdout, 'partial-out\n');
        assert.equal(error.details?.stderr, 'Failure: permission service crashed\n');
        assert.equal(error.details?.appPackage, 'com.example.app');
        assert.equal(error.details?.permission, 'android.permission.CAMERA');
        return true;
      },
    );
    assert.deepEqual(fake.flatPmCalls(), [
      'shell pm grant --user 0 com.example.app android.permission.INTERNET',
      'shell pm grant --user 0 com.example.app android.permission.CAMERA',
    ]);
    assert.ok(
      calls.every((args) => !args.includes('appops')),
      'notifications unit must not run after earlier pm batch hard failure',
    );
  });
});

test('host adb refusal or mid-batch transport truncation surfaces classified error for the uncompleted permission', async () => {
  const requested = ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'];

  // Host adb refuses before device shell runs (no markers at all).
  await withFakeAdb(
    (args) => {
      if (args.join(' ') === DUMPSYS) return makeDumpsys(requested);
      if (isAndroidPmBatchShellArgs(args)) {
        return { stdout: '', stderr: 'adb: device offline', exitCode: 1 };
      }
      return undefined;
    },
    async ({ device }) => {
      await assert.rejects(
        () =>
          setAndroidPermission(
            device,
            'com.example.app',
            parseAndroidPermissionRequest('grant', { permissionTarget: 'all' }),
            0,
          ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /CAMERA/);
          assert.equal(error.details?.adbFailure, 'device_offline');
          assert.equal(error.details?.adbHostRefusal, true);
          return true;
        },
      );
    },
  );

  // Mid-batch truncation: record 0 completed, record 1 truncated by transport drop.
  await withFakeAdb(
    (args) => {
      if (args.join(' ') === DUMPSYS) return makeDumpsys(requested);
      if (isAndroidPmBatchShellArgs(args)) {
        const match = /'(__AD_PM_BATCH_[0-9a-f]+__):OUT:'/.exec(args[1]!);
        assert.ok(match?.[1]);
        const marker = match[1];
        return {
          stdout: `${marker}:OUT:0\n${marker}:ERR:0:0\n${marker}:END:0\n${marker}:OUT:1\npartial`,
          stderr: "adb: protocol fault (couldn't read status)",
          exitCode: 1,
        };
      }
      return undefined;
    },
    async ({ device }) => {
      await assert.rejects(
        () =>
          setAndroidPermission(
            device,
            'com.example.app',
            parseAndroidPermissionRequest('grant', { permissionTarget: 'all' }),
            0,
          ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, 'COMMAND_FAILED');
          assert.match(error.message, /RECORD_AUDIO/);
          assert.equal(error.details?.permission, 'android.permission.RECORD_AUDIO');
          assert.equal(error.details?.stdout, 'partial');
          assert.equal(error.details?.adbFailure, 'connection_dropped');
          return true;
        },
      );
    },
  );
});

test('host adb passes no batch timeout while scoped remote providers receive a capped batch timeout', async () => {
  assert.equal(androidPmBatchTimeoutMs(1, false), 30_500);
  assert.equal(androidPmBatchTimeoutMs(55, false), 57_500);
  assert.equal(androidPmBatchTimeoutMs(55, true), 90_000);
  assert.equal(androidPmBatchTimeoutMs(200, true), 90_000);

  const requested = ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO'];
  const observedTimeouts: Array<number | undefined> = [];
  const pmCalls: string[][] = [];

  bindAndroidAdbHostStub({
    execAdb: async (invocation, options) => {
      const args = [...invocation.command];
      if (args.join(' ') === DUMPSYS) {
        return { stdout: makeDumpsys(requested), stderr: '', exitCode: 0 };
      }
      if (isAndroidPmBatchShellArgs(args)) {
        observedTimeouts.push(options?.timeoutMs);
        const reply = runFakeAndroidPmBatchInSh(args[1]!, {}, pmCalls);
        assert.ok(typeof reply === 'object' && !(reply instanceof Error));
        return {
          stdout: reply.stdout ?? '',
          stderr: reply.stderr ?? '',
          exitCode: reply.exitCode ?? 0,
        };
      }
      return { stdout: '', stderr: `unexpected host adb args: ${args.join(' ')}`, exitCode: 1 };
    },
  });
  try {
    const result = await setAndroidPermission(
      ANDROID_EMULATOR,
      'com.example.app',
      parseAndroidPermissionRequest('grant', { permissionTarget: 'all' }),
      0,
    );
    assert.deepEqual(result, {
      permission: 'all',
      permissions: requested,
    });
    assert.deepEqual(observedTimeouts, [undefined]);
  } finally {
    bindAndroidAdbTestHost();
  }
});

test('batch script safely quotes adversarial permission ids and preserves exact stdout and stderr bytes', () => {
  const marker = '__AD_PM_BATCH_0123456789abcdef__';
  const trickyPermissions = [
    "com.example.app.PERM'WITH'QUOTES",
    'com.example.app.PERM $(echo INJECTED); touch /nonexistent',
    'com.example.app.PERM `uname` $HOME "double" \\slash',
  ];
  const skipPhrases = ['not a changeable permission', 'unknown permission'];
  const script = buildAndroidPmBatchScript({
    pmAction: 'grant',
    clearFlags: false,
    userArgs: ['--user', '0'],
    appPackage: 'com.example.app',
    permissions: trickyPermissions,
    skipPhrases,
    marker,
  });

  const recorded: string[][] = [];
  const reply = runFakeAndroidPmBatchInSh(
    script,
    {
      [`shell pm grant --user 0 com.example.app ${trickyPermissions[0]}`]: {
        stdout: 'line-no-newline',
        stderr: '',
        exitCode: 0,
      },
      [`shell pm grant --user 0 com.example.app ${trickyPermissions[1]}`]: {
        stdout: 'out %s \\n\n',
        stderr: 'Unknown permission %s \\\\ with trailing newlines\n\n',
        exitCode: 1,
      },
      [`shell pm grant --user 0 com.example.app ${trickyPermissions[2]}`]: {
        stdout: '',
        stderr: '',
        exitCode: 0,
      },
    },
    recorded,
  );
  assert.ok(typeof reply === 'object' && !(reply instanceof Error));
  assert.equal(reply.exitCode, 0);

  // Every permission reached `pm` verbatim as argv[4] with zero shell expansion or splitting.
  assert.deepEqual(
    recorded.map((argv) => argv[4]),
    trickyPermissions,
  );

  const parsed = parseAndroidPmBatchOutput(reply.stdout ?? '', marker, trickyPermissions.length);
  assert.equal(parsed.partialStdout, '');
  assert.deepEqual(parsed.records, [
    { index: 0, exitCode: 0, stdout: 'line-no-newline', stderr: '' },
    {
      index: 1,
      exitCode: 1,
      stdout: 'out %s \\n\n',
      stderr: 'Unknown permission %s \\\\ with trailing newlines\n\n',
    },
    { index: 2, exitCode: 0, stdout: '', stderr: '' },
  ]);
});

test('chunkAndroidPmBatch splits large lists under maxScriptBytes and keeps oversized single ids intact', () => {
  const marker = '__AD_PM_BATCH_0123456789abcdef__';
  const permissions = Array.from({ length: 80 }, (_, i) => `com.example.app.permission.PERM_${i}`);
  const skipPhrases = ['not a changeable permission', 'unknown permission'];
  const chunks = chunkAndroidPmBatch(
    {
      pmAction: 'revoke',
      clearFlags: true,
      userArgs: ['--user', '0'],
      appPackage: 'com.example.app',
      permissions,
      skipPhrases,
      marker,
    },
    1_500,
  );
  assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
  assert.deepEqual(chunks.flat(), permissions);
  for (const chunk of chunks) {
    const script = buildAndroidPmBatchScript({
      pmAction: 'revoke',
      clearFlags: true,
      userArgs: ['--user', '0'],
      appPackage: 'com.example.app',
      permissions: chunk,
      skipPhrases,
      marker,
    });
    assert.ok(
      Buffer.byteLength(script, 'utf8') <= 1_500,
      `chunk exceeded budget: ${Buffer.byteLength(script, 'utf8')} bytes`,
    );
  }

  // An oversized single permission still forms a 1-item chunk without looping forever.
  const huge = `com.example.app.${'A'.repeat(2_000)}`;
  const oversized = chunkAndroidPmBatch(
    {
      pmAction: 'grant',
      clearFlags: false,
      userArgs: ['--user', '0'],
      appPackage: 'com.example.app',
      permissions: [huge, 'android.permission.CAMERA'],
      skipPhrases,
      marker,
    },
    1_500,
  );
  assert.deepEqual(oversized, [[huge], ['android.permission.CAMERA']]);
});

test('parseAndroidPmBatchOutput accepts CRLF line endings from legacy pty adb shells', () => {
  const marker = '__AD_PM_BATCH_0123456789abcdef__';
  const stdout =
    `${marker}:OUT:0\r\nok\r\n${marker}:ERR:0:0\r\n${marker}:END:0\r\n` +
    `${marker}:OUT:1\r\n${marker}:ERR:1:1\r\nnot a changeable permission\r\n${marker}:END:1\r\n`;
  const parsed = parseAndroidPmBatchOutput(stdout, marker, 2);
  assert.equal(parsed.partialStdout, '');
  assert.deepEqual(parsed.records, [
    { index: 0, exitCode: 0, stdout: 'ok\r\n', stderr: '' },
    { index: 1, exitCode: 1, stdout: '', stderr: 'not a changeable permission\r\n' },
  ]);
});
