import fs from 'node:fs';
import path from 'node:path';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { readVersion } from '@agent-device/host-kit/version';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { expect, test, vi } from 'vitest';
import { withTestDeviceInventory } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { handleDoctorCommand } from './session-doctor.ts';
import { hostDiagnosticsFixture } from '../../__tests__/support/host-diagnostics-fixture.ts';
import { installProviderDeviceAdmission } from '../../core/provider-device-admission.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { installDriftCheck, type InstallProbe } from './session-doctor-version-drift.ts';

vi.mock('./session-doctor-app.ts', () => ({
  appendAppChecks: vi.fn(async () => {}),
}));
vi.mock('./session-doctor-metro.ts', () => ({
  probeMetro: vi.fn(async () => ({ id: 'metro', status: 'pass', summary: 'mocked' })),
}));

const hostDiagnostics = hostDiagnosticsFixture();

function check(summary: string, version: string | null): InstallProbe {
  return { path: `/opt/bin/agent-device-${summary}`, version };
}

test('install-drift warns and names both versions when a PATH install differs', () => {
  const result = installDriftCheck('0.21.42-dev', [check('global', '0.21.36')]);

  expect(result).toMatchObject({
    id: 'install-drift',
    status: 'warn',
    summary: 'agent-device on PATH reports 0.21.36; this daemon runs 0.21.42-dev.',
  });
  expect(result.hint).toContain('one agent-device build per project');
  expect(result.evidence).toEqual({
    daemonVersion: '0.21.42-dev',
    binaries: [{ path: check('global', '').path, version: '0.21.36' }],
  });
});

test('install-drift lists each differing version once when several installs drift', () => {
  const result = installDriftCheck('1.0.0', [
    { path: '/a', version: '0.9.0' },
    { path: '/b', version: '0.9.0' },
    { path: '/c', version: null },
  ]);

  expect(result.status).toBe('warn');
  expect(result.summary).toContain('0.9.0');
  expect(result.summary).not.toContain(', 0.9.0, 0.9.0');
});

test('install-drift passes when every PATH install matches the daemon build', () => {
  const result = installDriftCheck('1.0.0', [
    { path: '/a', version: '1.0.0' },
    { path: '/b', version: '1.0.0' },
  ]);

  expect(result.status).toBe('pass');
  expect(result.hint).toBeUndefined();
});

test('install-drift passes when PATH reaches no agent-device binary', () => {
  const result = installDriftCheck('1.0.0', []);

  expect(result.status).toBe('pass');
  expect(result.summary).toContain('No agent-device binary found on PATH');
});

test('install-drift stays informational when no PATH install reports a version', () => {
  const result = installDriftCheck('1.0.0', [
    { path: '/a', version: null },
    { path: '/b', version: null },
  ]);

  expect(result.status).toBe('info');
});

async function runDoctorWithFakeInstallOnPath(params: {
  installDir: string;
  versionOutput: string;
}): Promise<{ response: DaemonResponse | null; versionProbes: Array<readonly string[]> }> {
  const binaryPath = path.join(params.installDir, 'agent-device');
  fs.writeFileSync(binaryPath, '#!/bin/sh\n');
  fs.chmodSync(binaryPath, 0o755);
  const versionProbes: Array<readonly string[]> = [];

  const response = await withCommandExecutorOverride(
    (command, args) => {
      if (command === binaryPath && args[0] === '--version') {
        versionProbes.push(args);
        return Promise.resolve({ stdout: params.versionOutput, stderr: '', exitCode: 0 });
      }
      return undefined;
    },
    async () =>
      await withTestDeviceInventory(
        {},
        async () =>
          await handleDoctorCommand({
            host: createTestHostEnvironment({ env: { PATH: params.installDir } }),
            req: { token: 't', session: 'default', command: 'doctor', positionals: [], flags: {} },
            sessionName: 'default',
            sessionStore: makeSessionStore('agent-device-doctor-drift-'),
            hostDiagnostics,
          }),
      ),
  );

  return { response, versionProbes };
}

function readCheck(response: DaemonResponse | null, id: string): Record<string, unknown> | null {
  if (!response?.ok) return null;
  const checks = (response.data as { checks?: Array<Record<string, unknown>> }).checks ?? [];
  return checks.find((check) => check.id === id) ?? null;
}

test('doctor warns when a PATH install reports a version the daemon does not run', async () => {
  installProviderDeviceAdmission({ isActive: () => false });
  const installDir = mkdtempForTestSync('agent-device-doctor-drift-install-');

  try {
    const { response, versionProbes } = await runDoctorWithFakeInstallOnPath({
      installDir,
      versionOutput: '9.9.9\n',
    });

    expect(response?.ok).toBe(true);
    expect(versionProbes).toEqual([['--version']]);
    expect(readCheck(response, 'install-drift')).toMatchObject({
      status: 'warn',
      summary: `agent-device on PATH reports 9.9.9; this daemon runs ${readVersion()}.`,
    });
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test('doctor passes the drift check when the PATH install matches the daemon build', async () => {
  installProviderDeviceAdmission({ isActive: () => false });
  const installDir = mkdtempForTestSync('agent-device-doctor-drift-install-');

  try {
    const { response } = await runDoctorWithFakeInstallOnPath({
      installDir,
      versionOutput: `${readVersion()}\n`,
    });

    expect(response?.ok).toBe(true);
    expect(readCheck(response, 'install-drift')).toMatchObject({ status: 'pass' });
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});

test('doctor reuses the drift verdict for the same PATH within the memo TTL', async () => {
  installProviderDeviceAdmission({ isActive: () => false });
  const installDir = mkdtempForTestSync('agent-device-doctor-drift-install-');
  const binaryPath = path.join(installDir, 'agent-device');
  fs.writeFileSync(binaryPath, '#!/bin/sh\n');
  fs.chmodSync(binaryPath, 0o755);
  const versionProbes: Array<readonly string[]> = [];
  const runDoctor = async (): Promise<DaemonResponse | null> =>
    await withCommandExecutorOverride(
      (command, args) => {
        if (command === binaryPath && args[0] === '--version') {
          versionProbes.push(args);
          return Promise.resolve({ stdout: '9.9.9\n', stderr: '', exitCode: 0 });
        }
        return undefined;
      },
      async () =>
        await withTestDeviceInventory(
          {},
          async () =>
            await handleDoctorCommand({
              host: createTestHostEnvironment({ env: { PATH: installDir } }),
              req: {
                token: 't',
                session: 'default',
                command: 'doctor',
                positionals: [],
                flags: {},
              },
              sessionName: 'default',
              sessionStore: makeSessionStore('agent-device-doctor-drift-'),
              hostDiagnostics,
            }),
        ),
    );

  try {
    const first = await runDoctor();
    const second = await runDoctor();

    expect(versionProbes).toEqual([['--version']]);
    expect(readCheck(second, 'install-drift')).toEqual(readCheck(first, 'install-drift'));
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
});
