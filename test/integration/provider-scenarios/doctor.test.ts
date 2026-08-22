import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import { assertRpcOk } from './assertions.ts';
import {
  PROVIDER_SCENARIO_ANDROID,
  PROVIDER_SCENARIO_IOS_SIMULATOR,
  PROVIDER_SCENARIO_LINUX,
  PROVIDER_SCENARIO_MACOS,
  PROVIDER_SCENARIO_WEB,
} from './fixtures.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  withProviderScenarioTempDir,
} from './harness.ts';

// The node-modules probe reads the root that `findProjectRoot()` resolves to. Left alone
// it is this source checkout, which is what the source-context assertion below wants; the
// packaged assertion points it at a directory shaped like a published install instead, so
// the real detection runs against a real packaged filesystem rather than a stubbed verdict.
const projectRootState = vi.hoisted(() => ({ override: undefined as string | undefined }));

vi.mock('../../../src/utils/version.ts', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/version.ts')>(
    '../../../src/utils/version.ts',
  );
  return {
    ...actual,
    findProjectRoot: () => projectRootState.override ?? actual.findProjectRoot(),
  };
});

afterEach(() => {
  projectRootState.override = undefined;
});

/** A published agent-device on disk: bin/ and dist/, no pnpm-lock.yaml, no node_modules. */
function layOutPackagedInstall(root: string): string {
  const packageRoot = path.join(root, 'node_modules', 'agent-device');
  fs.mkdirSync(path.join(packageRoot, 'dist', 'src'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    `${JSON.stringify({ name: 'agent-device', version: '0.0.0-test' })}\n`,
  );
  assert.equal(
    fs.existsSync(path.join(packageRoot, 'pnpm-lock.yaml')),
    false,
    'sanity: a packaged install ships no lockfile',
  );
  return packageRoot;
}

test('Provider-backed integration doctor infers Android RN/Metro readiness through daemon route without resolving a default device', async () => {
  const server = await startMetroStatusServer();
  const adbCalls: string[][] = [];
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => {
      adbCalls.push([...args]);
      return androidDoctorAdbResult(args, server.port);
    },
  };

  try {
    await withProviderScenarioTempDir(
      'agent-device-doctor-rn-',
      async (cwd) =>
        await withProviderScenarioResource(
          async () =>
            await createProviderScenarioHarness({
              androidAdbProvider: () => adbProvider,
              deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
            }),
          async (daemon) => {
            writePackageJson(cwd, { dependencies: { 'react-native': '0.0.0' } });
            const response = await daemon.callCommand(
              'doctor',
              [],
              { platform: 'android' },
              {
                meta: { cwd },
                runtime: { metroPort: server.port },
              },
            );
            assertRpcOk(response);
            const data = response.json.result.data;
            assert.equal(data.status, 'pass', JSON.stringify(data.checks));
            assert.equal(data.kind, 'react-native');
            assertDoctorCheck(data, 'device', 'pass');
            assertDoctorCheck(data, 'metro', 'pass');
            assertNoDoctorCheck(data, 'android-reverse');
            assert.deepEqual(adbCalls, []);
          },
        ),
    );
  } finally {
    await server.close();
  }
}, 15_000);

test('Provider-backed integration doctor runs predictably for supported platform selectors', async () => {
  const devices = [
    PROVIDER_SCENARIO_ANDROID,
    PROVIDER_SCENARIO_IOS_SIMULATOR,
    PROVIDER_SCENARIO_MACOS,
    PROVIDER_SCENARIO_LINUX,
    PROVIDER_SCENARIO_WEB,
  ];
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => androidDoctorAdbResult(args, 8081),
  };

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => adbProvider,
        deviceInventoryProvider: async () => devices,
      }),
    async (daemon) => {
      for (const device of devices) {
        const response = await daemon.callCommand('doctor', [], {
          platform: device.platform,
        });
        assertRpcOk(response);
        const data = response.json.result.data;
        assert.equal(data.platform, device.platform);
        assert.ok(Array.isArray(data.checks), `${device.platform} checks`);
      }
    },
  );
}, 15_000);

test('Provider-backed integration doctor --app verifies an installed app without opening a session', async () => {
  const adbCalls: string[][] = [];
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => {
      adbCalls.push([...args]);
      return androidDoctorAdbResult(args, 8081);
    },
  };

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        platformRuntime: true,
        androidAdbProvider: () => adbProvider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      }),
    async (daemon) => {
      const response = await daemon.callCommand('doctor', [], {
        platform: 'android',
        targetApp: 'com.example.demo',
      });
      assertRpcOk(response);
      const data = response.json.result.data;
      assert.equal(data.status, 'pass', JSON.stringify(data.checks));
      const app = assertDoctorCheck(data, 'target-app', 'pass');
      assert.match(app.summary, /com\.example\.demo/);
      assert.ok(
        adbCalls.some((args) => args.includes('query-activities')),
        JSON.stringify(adbCalls),
      );
    },
  );
});

test('Provider-backed integration doctor --app asks for a selector when multiple devices are booted', async () => {
  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        deviceInventoryProvider: async (request) => {
          if (!request.platform)
            return [PROVIDER_SCENARIO_ANDROID, PROVIDER_SCENARIO_IOS_SIMULATOR];
          if (request.platform === 'android') return [PROVIDER_SCENARIO_ANDROID];
          if (request.platform === 'apple') return [PROVIDER_SCENARIO_IOS_SIMULATOR];
          return [];
        },
      }),
    async (daemon) => {
      const response = await daemon.callCommand('doctor', [], {
        targetApp: 'com.example.demo',
      });
      assertRpcOk(response);
      const data = response.json.result.data;
      assert.equal(data.status, 'fail', JSON.stringify(data.checks));
      const appDevice = assertDoctorCheck(data, 'target-app-device', 'fail');
      assert.match(appDevice.summary, /2 matched/);
      assertNoDoctorCheck(data, 'target-app');
    },
  );
});

test('Provider-backed integration doctor --remote skips local device inventory', async () => {
  let inventoryCalls = 0;

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        deviceInventoryProvider: async () => {
          inventoryCalls += 1;
          return [PROVIDER_SCENARIO_ANDROID];
        },
      }),
    async (daemon) => {
      const response = await daemon.callCommand('doctor', [], {
        remote: true,
        daemonBaseUrl: 'https://example.invalid/agent-device',
      });
      assertRpcOk(response);
      const data = response.json.result.data;
      assert.equal(data.status, 'pass');
      assertDoctorCheck(data, 'remote-connection', 'pass');
      assertNoDoctorCheck(data, 'device');
      assert.equal(inventoryCalls, 0);
    },
  );
});

test('Provider-backed integration doctor --remote accepts provider profile scope', async () => {
  let inventoryCalls = 0;

  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        deviceInventoryProvider: async () => {
          inventoryCalls += 1;
          return [PROVIDER_SCENARIO_ANDROID];
        },
      }),
    async (daemon) => {
      const response = await daemon.callCommand('doctor', [], {
        remote: true,
        leaseProvider: 'browserstack',
        providerApp: 'bs://app-id',
        providerOsVersion: '14.0',
      });
      assertRpcOk(response);
      const data = response.json.result.data;
      assert.equal(data.status, 'pass');
      const remote = assertDoctorCheck(data, 'remote-connection', 'pass');
      assert.deepEqual(remote.evidence, {
        leaseProvider: '<configured>',
        providerApp: '<configured>',
        providerOsVersion: '<configured>',
      });
      assertNoDoctorCheck(data, 'device');
      assert.equal(inventoryCalls, 0);
    },
  );
});

test('Provider-backed integration doctor --remote fails without remote scope', async () => {
  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      }),
    async (daemon) => {
      const response = await daemon.callCommand('doctor', [], { remote: true });
      assertRpcOk(response);
      const data = response.json.result.data;
      assert.equal(data.status, 'fail');
      assertDoctorCheck(data, 'remote-connection', 'fail');
      assertNoDoctorCheck(data, 'device');
    },
  );
});

test('Provider-backed integration doctor probes Metro when runtime metadata exists outside an RN project', async () => {
  const server = await startMetroStatusServer();
  try {
    await withProviderScenarioResource(
      async () =>
        await createProviderScenarioHarness({
          deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
        }),
      async (daemon) => {
        // No RN/Expo cwd -> kind stays 'auto', so Metro is only probed after
        // an app/session flow has supplied runtime metadata.
        const withoutRuntime = await daemon.callCommand('doctor', [], { platform: 'ios' });
        assertRpcOk(withoutRuntime);
        assertNoDoctorCheck(withoutRuntime.json.result.data, 'metro');

        const withRuntime = await daemon.callCommand(
          'doctor',
          [],
          { platform: 'ios' },
          { runtime: { metroPort: server.port } },
        );
        assertRpcOk(withRuntime);
        const data = withRuntime.json.result.data;
        const metro = assertDoctorCheck(data, 'metro', 'pass');
        assert.equal(
          (metro.evidence as { url?: string }).url,
          `http://127.0.0.1:${server.port}/status`,
        );
      },
    );
  } finally {
    await server.close();
  }
}, 10_000);

test('Provider-backed integration doctor surfaces a platform inventory failure even when another platform has devices', async () => {
  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        deviceInventoryProvider: async (request) => {
          if (request.platform === 'apple') {
            throw new Error('xcrun: error: unable to find utility "simctl"');
          }
          return request.platform === 'android' ? [PROVIDER_SCENARIO_ANDROID] : [];
        },
      }),
    async (daemon) => {
      const response = await daemon.callCommand('doctor', []);
      assertRpcOk(response);
      const data = response.json.result.data;
      assert.equal(data.status, 'warn', JSON.stringify(data.checks));
      assertDoctorCheck(data, 'device', 'pass');
      const failure = assertDoctorCheck(data, 'device-apple', 'warn');
      assert.match(failure.summary, /simctl/);
    },
  );
});

test('Provider-backed integration doctor reports the node-modules probe in a source checkout', async () => {
  // The #1963 value, asserted at the route: from a real source worktree the probe is
  // present and passing. Without this, the two omission assertions below could both hold
  // for the trivial reason that the probe never runs anywhere.
  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      }),
    async (daemon) => {
      const response = await daemon.callCommand('doctor', [], { platform: 'android' });
      assertRpcOk(response);
      const data = response.json.result.data;
      assertDoctorCheck(data, 'node-modules', 'pass');
    },
  );
});

test('Provider-backed integration doctor omits the node-modules probe for a packaged install', async () => {
  // A published agent-device ships neither pnpm-lock.yaml nor an installed snapshot, so an
  // unconditional probe gave every end user a spurious node-modules line and dragged the
  // overall status to warn. The probe must be absent, and the status must not be degraded.
  await withProviderScenarioTempDir(
    'agent-device-doctor-packaged-',
    async (root) =>
      await withProviderScenarioResource(
        async () =>
          await createProviderScenarioHarness({
            deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
          }),
        async (daemon) => {
          projectRootState.override = layOutPackagedInstall(root);

          const response = await daemon.callCommand('doctor', [], { platform: 'android' });
          assertRpcOk(response);
          const data = response.json.result.data;
          assertNoDoctorCheck(data, 'node-modules');
          assert.equal(data.status, 'pass', JSON.stringify(data.checks));
          assert.equal(
            data.checks.some((check: { summary: string }) => /lockfile/i.test(check.summary)),
            false,
            `no packaged check may mention a lockfile: ${JSON.stringify(data.checks)}`,
          );
        },
      ),
  );
});

test('Provider-backed integration doctor --remote omits the node-modules probe', async () => {
  // --remote diagnoses the caller's connection to a remote daemon; the daemon's own root
  // would describe the server deployment rather than the caller's worktree, so the probe
  // cannot answer #1963 there. The project root is left as this real source checkout, so a
  // missing gate would surface the check rather than silently agreeing with the assertion.
  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      }),
    async (daemon) => {
      const response = await daemon.callCommand('doctor', [], {
        remote: true,
        daemonBaseUrl: 'https://example.invalid/agent-device',
      });
      assertRpcOk(response);
      const data = response.json.result.data;
      assert.equal(data.status, 'pass', JSON.stringify(data.checks));
      assertNoDoctorCheck(data, 'node-modules');
    },
  );
});

function writePackageJson(dir: string, value: Record<string, unknown>): void {
  fs.writeFileSync(`${dir}/package.json`, `${JSON.stringify(value)}\n`);
}

function assertDoctorCheck(
  data: {
    checks: Array<{
      id: string;
      status: string;
      summary: string;
      evidence?: Record<string, unknown>;
    }>;
  },
  id: string,
  status: string,
): { id: string; status: string; summary: string; evidence?: Record<string, unknown> } {
  const check = data.checks.find((entry) => entry.id === id);
  assert.ok(check, `missing ${id}: ${JSON.stringify(data.checks)}`);
  assert.equal(check.status, status);
  return check;
}

function assertNoDoctorCheck(data: { checks: Array<{ id: string }> }, id: string): void {
  assert.equal(
    data.checks.some((entry) => entry.id === id),
    false,
    `unexpected ${id}: ${JSON.stringify(data.checks)}`,
  );
}

function androidDoctorAdbResult(
  args: string[],
  metroPort: number,
): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const command = args.join(' ');
  if (args.includes('query-activities')) {
    return {
      stdout: 'com.example.demo/.MainActivity\ncom.example.settings/.MainActivity\n',
      stderr: '',
      exitCode: 0,
    };
  }
  if (command === 'reverse --list') {
    return {
      stdout: `emulator-5554 tcp:${metroPort} tcp:${metroPort}\n`,
      stderr: '',
      exitCode: 0,
    };
  }
  return { stdout: '', stderr: '', exitCode: 0 };
}

async function startMetroStatusServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('packager-status:running');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    port: address.port,
    close: async () =>
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
