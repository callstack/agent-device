import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAgentDeviceClient } from '../index.ts';
import { createClientTransport, mkdtempForTestSync } from '@agent-device/test-kit';

// `open` records where the session's device runs, and that is what lets a later flagless
// `metro reload` read this machine's simulator containers and listening ports at all. These pin the
// mapping from the daemon's device-selection answer to that trait, through the real open path.

type RecordedApp = {
  platform: string;
  deviceId: string;
  appId: string;
  hostedLocally?: boolean;
};

/** An `open` answered by a local daemon, as the given device-selection metadata reports it. */
async function openWith(selection: unknown): Promise<{ stateDir: string; app: RecordedApp }> {
  const stateDir = mkdtempForTestSync('agent-device-client-open-host-');
  const setup = createClientTransport(async () => ({
    ok: true,
    data: {
      session: 'qa',
      platform: 'ios',
      id: 'UDID-1',
      device: 'iPhone Air',
      kind: 'simulator',
      appBundleId: 'com.example.app',
      ...(selection === undefined ? {} : { selection }),
    },
  }));
  const client = createAgentDeviceClient(
    { ...setup.config, stateDir, daemonBaseUrl: 'http://127.0.0.1:1' },
    { transport: setup.transport, host: { env: {}, cwd: stateDir } },
  );

  await client.apps.open({ app: 'com.example.app', platform: 'ios' });

  const record = JSON.parse(
    fs.readFileSync(path.join(stateDir, 'metro-sessions', 'qa.json'), 'utf8'),
  ) as { app?: RecordedApp };
  assert.ok(record.app, 'open records the app a later reload looks the dev server up from');
  return { stateDir, app: record.app };
}

function selectionWith(source: string) {
  return { reason: 'single-booted-local', source, candidateCount: 1, bootOccurred: false };
}

test('an open that resolved the device locally records it as hosted here', async () => {
  const { stateDir, app } = await openWith(selectionWith('local'));
  try {
    assert.equal(app.hostedLocally, true);
    assert.equal(app.deviceId, 'UDID-1');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an open of a provider device records it as not hosted here', async () => {
  const { stateDir, app } = await openWith(selectionWith('provider'));
  try {
    // A provider's device can be anywhere, so a reload may not read this machine's state for it.
    assert.equal(app.hostedLocally, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an open that says nothing about the device records no host trait at all', async () => {
  // `session` means the device was carried over from an earlier request: that says nothing about where
  // it runs, so it must stay unproven rather than claim either way.
  const { stateDir, app } = await openWith(selectionWith('session'));
  try {
    assert.equal('hostedLocally' in app, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an open response without a selection block records no host trait either', async () => {
  const { stateDir, app } = await openWith(undefined);
  try {
    assert.equal('hostedLocally' in app, false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
