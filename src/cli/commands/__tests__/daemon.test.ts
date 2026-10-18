import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import type { DaemonStopResult } from '@agent-device/daemon-contracts/daemon-stop';
import {
  mkdtempForTestSync,
  bindTestCommandHost,
  createTestHostEnvironment,
} from '@agent-device/test-kit';

const mocks = vi.hoisted(() => ({
  cleanupDaemonOwner: vi.fn(async () => undefined),
  readDaemonShutdownReport: vi.fn(),
  readDaemonStatus: vi.fn(),
  stopDaemon: vi.fn(),
  writeCommandOutput: vi.fn(),
}));

// The mock specifier must be the SUT's exact `@agent-device/daemon-contracts/daemon-stop`: the
// mutation lane aliases only the manifest's exact entries, so the `./testing/*` pattern
// form resolved outside the Stryker sandbox and the mock silently missed (#3546 CI).
vi.mock('@agent-device/daemon-contracts/daemon-stop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/daemon-contracts/daemon-stop')>()),
  stopDaemon: mocks.stopDaemon,
}));
vi.mock('@agent-device/daemon-contracts/daemon-shutdown-report', () => ({
  readDaemonShutdownReport: mocks.readDaemonShutdownReport,
}));
vi.mock('../../../platform-runtime-daemon-owner-cleanup.ts', () => ({
  createDaemonOwnerCleanup: () => ({ cleanup: mocks.cleanupDaemonOwner }),
}));
// `readDaemonStopIdentity` stays real: these tests write the record they want judged, which is the
// only way to show routing, retirement, and a `--clean` walk judge one read of one file.
vi.mock('@agent-device/daemon-contracts/daemon-registration', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/daemon-contracts/daemon-registration')>()),
  readDaemonStatus: mocks.readDaemonStatus,
}));
vi.mock('../shared.ts', () => ({ writeCommandOutput: mocks.writeCommandOutput }));

import { daemonCommand } from '../daemon.ts';
import * as daemonClientStop from '../../../daemon-client/daemon-client-stop.ts';

bindTestCommandHost();

const GRACEFUL_RESULT: DaemonStopResult = {
  stopped: true,
  mode: 'graceful',
  cleanupConfidence: 'known',
  claimsReleased: [],
  claimsOrphaned: [],
  claimsSuperseded: [],
  claimsUnattributable: [],
  providerReleases: { status: 'completed', released: [], pending: [] },
  warnings: [],
};

/** A detached daemon's record, which is the shape a `--clean` cleanup is allowed to follow. */
function writeDetachedRecord(stateDir: string): void {
  fs.writeFileSync(
    `${stateDir}/daemon.json`,
    JSON.stringify({ pid: 123, processStartTime: 'start' }),
    {
      mode: 0o600,
    },
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

test('accepts only daemon stop and status', async () => {
  await assert.rejects(
    async () =>
      await daemonCommand({
        host: createTestHostEnvironment(),
        positionals: [],
        flags: { help: false, json: false, version: false },
        client: {} as never,
      }),
    (error: { code?: string }) => error.code === 'INVALID_ARGS',
  );
  await assert.rejects(
    async () =>
      await daemonCommand({
        host: createTestHostEnvironment(),
        positionals: ['stop', 'extra'],
        flags: { help: false, json: false, version: false },
        client: {} as never,
      }),
    (error: { code?: string }) => error.code === 'INVALID_ARGS',
  );
});

test('merges a graceful shutdown report and cleans runner leases with the start-time identity', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-command-');
  writeDetachedRecord(stateDir);
  mocks.stopDaemon.mockImplementationOnce(async () => {
    fs.writeFileSync(
      `${stateDir}/daemon.json`,
      JSON.stringify({ pid: 456, processStartTime: 'successor', ownership: 'embedded' }),
    );
    return GRACEFUL_RESULT;
  });
  const claim = {
    deviceKey: 'local:android:none:emulator-5554',
    session: 'default',
    platform: 'android',
    deviceId: 'emulator-5554',
  };
  mocks.readDaemonShutdownReport.mockReturnValue({
    providerReleases: {
      released: [{ leaseId: 'lease-1', provider: 'limrun' }],
      pending: [],
    },
    claims: { released: [claim], orphaned: [], superseded: [], unattributable: [] },
  });

  try {
    await daemonCommand({
      host: createTestHostEnvironment(),
      positionals: ['stop'],
      flags: { clean: true, help: false, json: false, stateDir, version: false },
      client: {} as never,
    });

    // The lifetime handed to the retirement is the one read out of that record, with the owner the
    // same read stated: routing and retirement judge one observation.
    expect(mocks.stopDaemon).toHaveBeenCalledWith({
      paths: expect.objectContaining({ baseDir: stateDir }),
      observed: { pid: 123, startTime: 'start', ownership: 'detached' },
    });
    expect(mocks.cleanupDaemonOwner).toHaveBeenCalledWith({
      pid: 123,
      startTime: 'start',
    });
    expect(mocks.writeCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({ clean: true, json: false }),
      expect.objectContaining({
        clean: true,
        providerReleases: {
          status: 'completed',
          released: [{ leaseId: 'lease-1', provider: 'limrun' }],
          pending: [],
        },
        // #1799: a graceful stop reports the claims it actually released.
        claimsReleased: [claim],
        claimsOrphaned: [],
        claimsSuperseded: [],
        claimsUnattributable: [],
      }),
      expect.any(Function),
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('reports graceful provider cleanup as unknown when the shutdown report is unavailable', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-command-');
  mocks.stopDaemon.mockResolvedValue(GRACEFUL_RESULT);
  mocks.readDaemonShutdownReport.mockReturnValue(null);

  try {
    await daemonCommand({
      host: createTestHostEnvironment(),
      positionals: ['stop'],
      flags: { help: false, json: false, stateDir, version: false },
      client: {} as never,
    });

    // No record at all is not a refusal: nothing claims the state directory, so this stop hands the
    // retirement no lifetime and still reports what it was told.
    expect(mocks.stopDaemon).toHaveBeenCalledWith({
      paths: expect.objectContaining({ baseDir: stateDir }),
      observed: null,
    });
    expect(mocks.writeCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({ json: false }),
      expect.objectContaining({
        clean: false,
        cleanupConfidence: 'unknown',
        providerReleases: { status: 'unknown', released: [], pending: null },
        warnings: [expect.stringContaining('provider cleanup state is unknown')],
      }),
      expect.any(Function),
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('warns in text output when a graceful stop leaves an orphaned claim', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-command-');
  writeDetachedRecord(stateDir);
  mocks.stopDaemon.mockResolvedValue(GRACEFUL_RESULT);
  const claim = {
    deviceKey: 'local:android:none:emulator-5554',
    session: 'default',
    platform: 'android',
    deviceId: 'emulator-5554',
  };
  mocks.readDaemonShutdownReport.mockReturnValue({
    providerReleases: { released: [], pending: [] },
    claims: { released: [], orphaned: [claim], superseded: [], unattributable: [] },
  });

  try {
    await daemonCommand({
      host: createTestHostEnvironment(),
      positionals: ['stop'],
      flags: { clean: false, help: false, json: false, stateDir, version: false },
      client: {} as never,
    });

    const [, data, renderHuman] = mocks.writeCommandOutput.mock.calls.at(-1) ?? [];
    expect(data).toEqual(
      expect.objectContaining({
        claimsOrphaned: [claim],
        warnings: [expect.stringContaining('was not released cleanly')],
      }),
    );
    const rendered = (renderHuman as () => string)();
    expect(rendered).toContain('Ownership of emulator-5554 was not released cleanly');
    expect(rendered).toContain('agent-device device release --stale');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('routes an unattributable claim to the default status view, never to --stale', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-command-');
  writeDetachedRecord(stateDir);
  mocks.stopDaemon.mockResolvedValue(GRACEFUL_RESULT);
  const claim = {
    deviceKey: 'local:android:none:emulator-5554',
    session: 'default',
    platform: 'android',
    deviceId: 'emulator-5554',
  };
  mocks.readDaemonShutdownReport.mockReturnValue({
    providerReleases: { released: [], pending: [] },
    claims: { released: [], orphaned: [], superseded: [], unattributable: [claim] },
  });

  try {
    await daemonCommand({
      host: createTestHostEnvironment(),
      positionals: ['stop'],
      flags: { clean: false, help: false, json: false, stateDir, version: false },
      client: {} as never,
    });

    const [, data, renderHuman] = mocks.writeCommandOutput.mock.calls.at(-1) ?? [];
    expect(data).toEqual(
      expect.objectContaining({
        claimsUnattributable: [claim],
        claimsOrphaned: [],
        warnings: [expect.stringContaining('whose owner could not be read')],
      }),
    );
    const rendered = (renderHuman as () => string)();
    expect(rendered).toContain('Inspect with: agent-device device status.');
    // The whole reason this is its own bucket: both stale routes refuse a record with no recorded
    // owner, so the warning may name them only to forbid them and must not end in a release.
    expect(rendered).toContain('No device release route settles it');
    expect(rendered).not.toContain('then release with');
    expect(rendered).not.toContain('Inspect with: agent-device device status --stale');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon status reads the daemon record without stopping or contacting the daemon', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-command-');
  const status = {
    state: 'running',
    stateDir,
    pid: 321,
    ownership: 'embedded',
    version: '0.21.30',
    plugins: [
      {
        provider: 'browserstack',
        source: 'builtin',
        state: 'active',
        credentials: { variables: [], byBackend: {} },
      },
      {
        provider: 'testmu',
        source: 'store',
        package: '@agent-device/testmu',
        version: '1.0.0',
        state: 'failed',
        error: { code: 'INVALID_ARGS', message: 'bad plugin' },
        credentials: { variables: [], byBackend: {} },
      },
    ],
  };
  mocks.readDaemonStatus.mockReturnValue(status);

  try {
    await daemonCommand({
      host: createTestHostEnvironment(),
      positionals: ['status'],
      flags: { help: false, json: true, stateDir, version: false },
      client: {} as never,
    });

    expect(mocks.stopDaemon).not.toHaveBeenCalled();
    expect(mocks.writeCommandOutput).toHaveBeenCalledWith(
      expect.objectContaining({ json: true }),
      status,
      expect.any(Function),
    );
    const render = mocks.writeCommandOutput.mock.calls[0]![2] as () => string;
    expect(render()).toContain('testmu [store] @agent-device/testmu@1.0.0 - failed: bad plugin');
    expect(render()).toContain('browserstack [builtin] builtin - active');
    // A host-owned pid changes what a stop may do to it, so status says who owns it.
    expect(render()).toContain('pid 321, host-owned');
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// `--clean` walks the owner's process tree. A host process's tree is that host's whole program, so the
// flag is refused for a host-owned record rather than reaching past the runtime's own close.
test.each([
  [
    'embedded',
    true,
    JSON.stringify({ pid: 555, processStartTime: 'start', ownership: 'embedded' }),
    'daemon-clean-not-detached',
    /Close the host/,
  ],
  [
    'unknown',
    true,
    JSON.stringify({ pid: 555, processStartTime: 'start', ownership: 'sideways' }),
    'daemon-clean-not-detached',
    /remove .*daemon\.json/,
  ],
  ['unreadable', true, '{not json', 'daemon-clean-not-detached', /remove .*daemon\.json/],
  ['unreadable', false, '{not json', 'daemon-record-unreadable', /Inspect or remove that record/],
] as const)('daemon stop refuses %s with clean=%s', async (_label, clean, record, reason, hint) => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-command-refused-');
  fs.writeFileSync(`${stateDir}/daemon.json`, record, { mode: 0o600 });
  try {
    await expect(
      daemonCommand({
        host: createTestHostEnvironment(),
        positionals: ['stop'],
        flags: { clean, help: false, json: false, stateDir, version: false },
        client: {} as never,
      }),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason, stateDir, hint: expect.stringMatching(hint) },
    });
    expect(mocks.stopDaemon).not.toHaveBeenCalled();
    expect(mocks.cleanupDaemonOwner).not.toHaveBeenCalled();
    expect(fs.readFileSync(`${stateDir}/daemon.json`, 'utf8')).toBe(record);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

// Status is the surface an operator reads before deciding what a stop may do, so an owner this build
// cannot place is said out loud instead of reading as an ordinary detached daemon.
test('daemon status names a record whose owner it cannot recognize', async () => {
  mocks.readDaemonStatus.mockReturnValue({
    state: 'running',
    stateDir: '/tmp/agent-device-daemon-status-unknown',
    pid: 321,
    ownership: 'unknown',
  });

  await daemonCommand({
    host: createTestHostEnvironment(),
    positionals: ['status'],
    flags: { help: false, json: false, stateDir: '/tmp/x', version: false },
    client: {} as never,
  });

  const render = mocks.writeCommandOutput.mock.calls.at(-1)![2] as () => string;
  expect(render()).toContain('pid 321, owner-not-recognized');
});

test('daemon stop of a host-owned record goes through the one router with the host the command runs on', async () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-command-embedded-');
  fs.writeFileSync(
    `${stateDir}/daemon.json`,
    JSON.stringify({ pid: 555, processStartTime: 'start-time', ownership: 'embedded' }),
    { mode: 0o600 },
  );
  vi.spyOn(daemonClientStop, 'stopRecordedDaemon').mockResolvedValue({
    ...GRACEFUL_RESULT,
    warnings: ['1 in-flight request ignored cancellation and was abandoned.'],
  });

  const host = createTestHostEnvironment();

  try {
    await daemonCommand({
      host,
      positionals: ['stop'],
      flags: { help: false, json: false, stateDir, version: false },
      client: {} as never,
    });

    // A host-owned runtime is never signaled, so it never reaches the retirement a detached stop uses.
    expect(mocks.stopDaemon).not.toHaveBeenCalled();
    const render = mocks.writeCommandOutput.mock.calls[0]![2] as () => string;
    expect(render()).toContain('Daemon stopped (graceful).');
    expect(render()).toContain('ignored cancellation');
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
