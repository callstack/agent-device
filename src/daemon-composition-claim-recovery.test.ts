import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  createOwnerScopedDeviceClaimReconciler,
  createRecoveryPlatformScope,
  inspectDeviceClaimRecovery,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import { releaseProvenStaleDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createTestHostEnvironment, pluginHome, selectPlugin } from '@agent-device/test-kit';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';
import { runStaleDeviceClaimRelease } from './platform-runtime-claim-recovery.ts';

const webPackage = '@agent-device/web';
// The runtime answers recovery as an owner whose recorder died with its daemon: nothing to reattach.
// The stock browser runtime answers `cleanup-pending` instead, so this double is the only web
// runtime a recovery can settle; what the test proves is which registration recovery binds.
const webPlugin = `
  const owner = { kind: 'local-family', family: 'web' };
  const available = { available: true };
  export default () => ({
    apiVersion: 3,
    contributes: [{
      kind: 'platform',
      family: 'web',
      setup() {
        return {
          family: 'web',
          createInteractor: async () => ({}),
          inventoryModule: { family: 'web', loadInventory: async () => ({ discover: async () => [] }) },
          runtimeModule: {
            family: 'web',
            loadRuntime: async () => ({
              owner,
              ownsDevice: (device) => device.platform === 'web',
              inspectFacts() { throw new Error('unused'); },
              bind: async ({ device }) => ({
                device,
                owner,
                facts: {
                  device: {
                    family: 'web',
                    kind: device.kind,
                    target: device.target,
                    providerMode: 'local',
                  },
                  operations: {
                    screenRecordingReattach: available,
                    screenRecordingCleanup: available,
                  },
                },
                operations: {
                  screenRecordingReattach: async () => ({ status: 'missing' }),
                  screenRecordingCleanup: async () => ({ status: 'already-missing' }),
                },
                [Symbol.asyncDispose]: async () => {},
              }),
              shutdown: async () => {},
            }),
          },
          withRequestProvider: async (_, task) => task(),
          operations: {
            setup() {},
            doctor() {},
            cleanupOrphans() {},
            browserLifecycleCheck() {},
            createProvider() {},
            resolveRequestProvider() {},
          },
        };
      },
    }],
  });
`;

const browser: DeviceInfo = {
  platform: 'web',
  id: 'agent-browser-chrome',
  name: 'Agent Browser Chrome',
  kind: 'device',
  target: 'desktop',
};
const session = 'dead-web-session';
const deviceKey = 'local:web:none:agent-browser-chrome';

/** A dead owner's web claim whose state dir still records an open screen recording. */
function seedStaleWebRecordingClaim(options: { webInstalled: boolean }) {
  const { home, env } = pluginHome();
  if (options.webInstalled) {
    selectPlugin(home, webPackage, webPlugin, { claims: { apiVersion: 3, platform: 'web' } });
  }
  const ownerStateDir = path.join(home, 'owner-state');
  const stateDir = path.join(home, 'state');
  const claimsDir = path.join(home, 'claims');
  const claimPath = path.join(
    claimsDir,
    `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`,
  );
  fs.mkdirSync(claimsDir, { recursive: true });
  fs.writeFileSync(
    claimPath,
    JSON.stringify({
      schemaVersion: 1,
      deviceKey,
      device: browser,
      session,
      workspace: '/worktrees/dead-owner',
      stateDir: ownerStateDir,
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start-time',
      ownerToken: 'dead-owner-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
  const recordingPath = screenRecordingResourceStore.resolvePath(
    path.join(ownerStateDir, 'sessions', session),
  );
  screenRecordingResourceStore.write(
    recordingPath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: session,
      device: deviceIdentity(browser),
      owner: localRuntimeOwner('web'),
      fence: { token: 'dead-owner-recording', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: {} },
      metadata: { phase: 'active' },
    }),
  );
  const host = createTestHostEnvironment({
    env: {
      ...process.env,
      ...env,
      AGENT_DEVICE_CLAIMS_DIR: claimsDir,
      AGENT_DEVICE_STATE_DIR: stateDir,
    },
    cwd: home,
  });
  return { host, stateDir, claimPath, recordingPath };
}

/** Releases stale claims as the daemon does: through the recovery gateway its composition returns. */
async function releaseThroughDaemonComposition(host: HostEnvironment, baseDir: string) {
  const sessionsDir = path.join(baseDir, 'sessions');
  return await createRuntimeStateHandle().run(async () => {
    const deps = await createDaemonRuntimeDeps({
      host,
      baseDir,
      sessionsDir,
      assertShutdownAllowed: undefined,
      resolveSessionDir: (name) => path.join(sessionsDir, name),
      resolveSessionArtifacts: () => {
        throw new Error('unused');
      },
      openWebSessionNames: () => [],
    });
    try {
      return await releaseProvenStaleDeviceClaims({
        selectors: {},
        env: host.env,
        reconcile: createOwnerScopedDeviceClaimReconciler({
          scope: createRecoveryPlatformScope(),
          composeGateway: deps.claimRecoveryGateway,
          beforeGateway: inspectDeviceClaimRecovery,
        }),
      });
    } finally {
      await deps.shutdownProviderRuntimes();
    }
  });
}

const releases = [
  {
    path: 'the daemon composition',
    release: (host: HostEnvironment, stateDir: string) =>
      releaseThroughDaemonComposition(host, stateDir),
  },
  {
    path: 'daemonless device release --stale',
    release: (host: HostEnvironment, stateDir: string) =>
      createRuntimeStateHandle().run(() => runStaleDeviceClaimRelease({}, host, { stateDir })),
  },
];

test.each(releases)(
  '$path settles a stale web claim recording through the installed web platform',
  async ({ release }) => {
    const { host, stateDir, claimPath, recordingPath } = seedStaleWebRecordingClaim({
      webInstalled: true,
    });

    const outcomes = await release(host, stateDir);

    expect(outcomes).toEqual([expect.objectContaining({ status: 'released', session })]);
    expect(fs.existsSync(claimPath)).toBe(false);
    expect(screenRecordingResourceStore.read(recordingPath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'completed', metadata: { recoveryStatus: 'already-missing' } },
    });
  },
);

test.each(releases)(
  '$path keeps a stale web claim recording while no web platform is installed',
  async ({ release }) => {
    const { host, stateDir, claimPath, recordingPath } = seedStaleWebRecordingClaim({
      webInstalled: false,
    });

    const outcomes = await release(host, stateDir);

    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'retained', reason: 'screen-recording-cleanup-pending' }),
    ]);
    expect(fs.existsSync(claimPath)).toBe(true);
    expect(screenRecordingResourceStore.read(recordingPath)).toMatchObject({
      envelope: { lifecycle: 'open' },
    });
  },
);
