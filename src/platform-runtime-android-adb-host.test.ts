import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { runAndroidHostAdb } from '@agent-device/platform-android/mechanics';
import { mkdtempForTestSync } from './__tests__/test-utils/tmp-dir.ts';
import './platform-runtime-android-adb-host.ts';

test.skipIf(process.platform === 'win32')(
  'the local host binding classifies a real nonzero adb process result',
  async () => {
    const tmpDir = mkdtempForTestSync('agent-device-adb-host-binding-');
    const adbPath = path.join(tmpDir, 'adb');
    fs.writeFileSync(
      adbPath,
      '#!/usr/bin/env node\nprocess.stderr.write("error: device offline\\n"); process.exit(1);',
    );
    fs.chmodSync(adbPath, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${tmpDir}${path.delimiter}${previousPath ?? ''}`;
    try {
      const error = await runAndroidHostAdb(['devices']).then(
        () => assert.fail('expected local adb to reject'),
        (error: unknown) => error,
      );

      assert.ok(error instanceof AppError);
      assert.equal(error.details?.adbFailure, 'device_offline');
      assert.equal(error.details?.retriable, true);
      assert.match(String(error.details?.hint), /adb reconnect/i);
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
    }
  },
);
