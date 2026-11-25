import { test } from 'vitest';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import path from 'node:path';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  clearMetroSessionHints,
  readMetroSessionAppTarget,
  readMetroSessionHints,
  recordOpenedMetroSession,
  recordPreparedMetroSession,
  writeMetroSessionHints,
} from './metro-session-hints.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

function tempStateDir(): string {
  const dir = path.join(
    mkdtempForTestSync('agent-device-metro-session-hints'),
    `agent-device-metro-session-hints-${randomUUID()}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('readMetroSessionHints returns undefined when no hints were written', () => {
  const stateDir = tempStateDir();
  try {
    assert.equal(readMetroSessionHints({ stateDir, session: 'default' }), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('writeMetroSessionHints and readMetroSessionHints round-trip per session', () => {
  const stateDir = tempStateDir();
  try {
    writeMetroSessionHints({
      stateDir,
      session: 'proj-a',
      hints: {
        controlBaseUrl: 'http://127.0.0.1:8082/',
      },
    });
    writeMetroSessionHints({
      stateDir,
      session: 'proj-b',
      hints: { controlBaseUrl: 'http://127.0.0.1:8090/' },
    });

    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'proj-a' }), {
      controlBaseUrl: 'http://127.0.0.1:8082/',
    });
    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'proj-b' }), {
      controlBaseUrl: 'http://127.0.0.1:8090/',
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('writeMetroSessionHints overwrites a previous hint for the same session', () => {
  const stateDir = tempStateDir();
  try {
    writeMetroSessionHints({
      stateDir,
      session: 'default',
      hints: { controlBaseUrl: 'http://127.0.0.1:8081/' },
    });
    writeMetroSessionHints({
      stateDir,
      session: 'default',
      hints: { controlBaseUrl: 'http://127.0.0.1:8082/' },
    });

    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'default' }), {
      controlBaseUrl: 'http://127.0.0.1:8082/',
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('clearMetroSessionHints removes a stored hint', () => {
  const stateDir = tempStateDir();
  try {
    writeMetroSessionHints({
      stateDir,
      session: 'default',
      hints: { controlBaseUrl: 'http://127.0.0.1:8082/' },
    });
    clearMetroSessionHints({ stateDir, session: 'default' });

    assert.equal(readMetroSessionHints({ stateDir, session: 'default' }), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('readMetroSessionHints ignores a corrupt hints file instead of throwing', () => {
  const stateDir = tempStateDir();
  try {
    const filePath = path.join(stateDir, 'metro-sessions', 'default.json');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'not json');

    assert.equal(readMetroSessionHints({ stateDir, session: 'default' }), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('sessions with unsafe characters get distinct sanitized files', () => {
  const stateDir = tempStateDir();
  try {
    writeMetroSessionHints({
      stateDir,
      session: 'feature/branch-a',
      hints: { controlBaseUrl: 'http://127.0.0.1:8082/' },
    });

    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'feature/branch-a' }), {
      controlBaseUrl: 'http://127.0.0.1:8082/',
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('released session records retain their reload address when read as a binding', () => {
  const stateDir = tempStateDir();
  const filePath = path.join(stateDir, 'metro-sessions', 'default.json');
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    JSON.stringify({ bundleUrl: 'https://metro.example.test/tenant-42/index.bundle?platform=ios' }),
  );
  assert.deepEqual(readMetroSessionHints({ stateDir, session: 'default' }), {
    controlBaseUrl: 'https://metro.example.test/tenant-42',
  });
});

const iosApp = {
  platform: 'ios',
  deviceKind: 'simulator',
  deviceId: 'UDID-1',
  appId: 'com.example.app',
  hostedLocally: true,
} as const;

function hostFor(stateDir: string): HostEnvironment {
  return { env: { AGENT_DEVICE_STATE_DIR: stateDir }, cwd: stateDir };
}

test('an open with no dev-server hint records the app a later reload looks up', () => {
  const stateDir = tempStateDir();
  try {
    recordOpenedMetroSession(
      { stateDir, session: 'fresh', host: hostFor(stateDir) },
      { runtime: undefined, explicitRuntime: false, sessionReused: false, app: iosApp },
    );

    assert.deepEqual(
      readMetroSessionAppTarget({ stateDir, session: 'fresh', host: hostFor(stateDir) }),
      iosApp,
    );
    // An app-only record binds no address, so it is never read as a binding.
    assert.equal(readMetroSessionHints({ stateDir, session: 'fresh' }), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a reused session that opens another app replaces the recorded app', () => {
  const stateDir = tempStateDir();
  try {
    const options = { stateDir, session: 'reused', host: hostFor(stateDir) };
    recordOpenedMetroSession(options, {
      runtime: undefined,
      explicitRuntime: false,
      sessionReused: false,
      app: iosApp,
    });
    recordOpenedMetroSession(options, {
      runtime: undefined,
      explicitRuntime: false,
      sessionReused: true,
      app: { ...iosApp, appId: 'com.other.app', deviceId: 'UDID-2' },
    });

    assert.deepEqual(readMetroSessionAppTarget({ ...options }), {
      ...iosApp,
      appId: 'com.other.app',
      deviceId: 'UDID-2',
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('re-recording the app keeps a binding the session already had', () => {
  const stateDir = tempStateDir();
  try {
    const options = { stateDir, session: 'bound', host: hostFor(stateDir) };
    recordPreparedMetroSession(options, {
      statusUrl: 'http://127.0.0.1:8096/status',
      iosRuntime: { metroHost: '127.0.0.1', metroPort: 8096 },
      androidRuntime: { metroHost: '127.0.0.1', metroPort: 8096, platform: 'android' },
    });
    recordOpenedMetroSession(options, {
      runtime: undefined,
      explicitRuntime: false,
      sessionReused: true,
      app: iosApp,
    });

    assert.deepEqual(readMetroSessionHints({ stateDir, session: 'bound' }), {
      controlBaseUrl: 'http://127.0.0.1:8096/',
      deviceBaseUrls: ['http://127.0.0.1:8096/'],
      app: iosApp,
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an open that reports no app leaves a reused session record alone and clears a fresh one', () => {
  const stateDir = tempStateDir();
  try {
    const options = { stateDir, session: 'keep', host: hostFor(stateDir) };
    recordOpenedMetroSession(options, {
      runtime: undefined,
      explicitRuntime: false,
      sessionReused: false,
      app: iosApp,
    });
    recordOpenedMetroSession(options, {
      runtime: undefined,
      explicitRuntime: false,
      sessionReused: true,
    });
    assert.deepEqual(readMetroSessionAppTarget({ ...options }), iosApp);

    recordOpenedMetroSession(options, {
      runtime: undefined,
      explicitRuntime: false,
      sessionReused: false,
    });
    assert.equal(readMetroSessionAppTarget({ ...options }), undefined);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the recorded app is read back only when its record names a real app on a device', () => {
  const stateDir = tempStateDir();
  const options = { stateDir, session: 'stored', host: hostFor(stateDir) };
  const file = path.join(stateDir, 'metro-sessions', 'stored.json');
  const write = (app: unknown) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ app }));
  };
  try {
    write(iosApp);
    assert.deepEqual(readMetroSessionAppTarget({ ...options }), iosApp);

    // A record from before the host trait, or one that says the device is elsewhere, is not local.
    write({ ...iosApp, hostedLocally: false });
    assert.deepEqual(readMetroSessionAppTarget({ ...options }), {
      platform: 'ios',
      deviceKind: 'simulator',
      deviceId: 'UDID-1',
      appId: 'com.example.app',
    });

    // A device kind the reader does not know stays absent: discovery decides on its own.
    write({ platform: 'android', deviceId: 'emulator-5554', deviceKind: 'phone' });
    assert.deepEqual(readMetroSessionAppTarget({ ...options }), {
      platform: 'android',
      deviceId: 'emulator-5554',
    });

    for (const app of [
      undefined,
      null,
      'string',
      [],
      {},
      { platform: 'web', deviceId: 'x' },
      { platform: 'ios' },
      { deviceId: 'UDID-1' },
    ]) {
      write(app);
      assert.equal(readMetroSessionAppTarget({ ...options }), undefined, JSON.stringify(app));
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an unusable state directory yields no recorded app instead of throwing', () => {
  assert.equal(
    readMetroSessionAppTarget({
      session: 's',
      host: { env: { AGENT_DEVICE_STATE_DIR: '../escape' }, cwd: '/tmp' },
    }),
    undefined,
  );
});
