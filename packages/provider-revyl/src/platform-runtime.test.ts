import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOwner,
} from '@agent-device/contracts/platform-runtime-operations';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import fs from 'node:fs/promises';
import path from 'node:path';
import { mkdtempForTest } from '@agent-device/test-kit';
import type { MaterializedAppSource } from '@agent-device/contracts/app-deployment-runtime';
import { createRevylPlatformRuntimeOwner } from './platform-runtime.ts';
import type { RevylDeploymentSession } from './deployment.ts';
import type { RevylClient } from './revyl-client.ts';

const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'revyl:ios:lease-1',
  name: 'Revyl ios run-1',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const OWNER = providerRuntimeOwner('revyl', 'instance');

/** Only the iOS snapshot presenter reaches this owner; the rest of the host stays unused. */
const HOST = {
  snapshot: { presentIosAcquisition: async () => ({ ok: true }) },
} as unknown as PlatformRuntimeHost;

function owner(options: {
  hasLiveSession: boolean;
  interactor?: Interactor;
  host?: PlatformRuntimeHost;
  deploymentSession?: RevylDeploymentSession;
}): PlatformRuntimeOwner {
  return createRevylPlatformRuntimeOwner({
    host: options.host ?? HOST,
    runtimeInstance: OWNER.instance,
    ownsDevice: () => true,
    hasLiveSession: () => options.hasLiveSession,
    getInteractor: () => options.interactor,
    getDeploymentSession: () => options.deploymentSession,
  });
}

async function bind(owner: PlatformRuntimeOwner, device = IOS_DEVICE) {
  return await owner.bind({
    device,
    intent: { kind: 'exact-owner', owner: OWNER },
    scope: { signal: new AbortController().signal },
  } as never);
}

test('an exact-owner bind of a device whose session has ended reports the facts inspectFacts reports', async () => {
  const ownerInstance = owner({ hasLiveSession: false });
  const binding = await bind(ownerInstance);
  // The gate reads the facts, so what the binding carries must be what inspection reports: a drift
  // between the two would let a gone session's operations through.
  assert.deepEqual(binding.facts, await ownerInstance.inspectFacts(IOS_DEVICE));
  assert.equal(binding.facts.operations.captureSnapshot.available, false);
  assert.equal(binding.facts.operations.openApplication.available, false);
});

test('a bind without an exact owner refuses a device with no live session', async () => {
  await assert.rejects(
    owner({ hasLiveSession: false }).bind({
      device: IOS_DEVICE,
      intent: { kind: 'provider-default' },
      scope: { signal: new AbortController().signal },
    } as never),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-session-unavailable',
  );
});

test('a live session binds the interactor-backed operations and refuses the rest', async () => {
  const binding = await bind(
    owner({ hasLiveSession: true, interactor: { tap: async () => {} } as unknown as Interactor }),
  );
  assert.ok(binding.operations.tapPoint);
  assert.ok(binding.operations.captureSnapshot);
  assert.ok(binding.operations.captureScreenshot);
  assert.ok(binding.operations.openApplication);
  assert.ok(binding.operations.home);
  assert.equal(binding.operations.tapRef, undefined);
  assert.equal(binding.operations.performGesturePlan, undefined);
  assert.equal(binding.operations.keyboardStatus, undefined);
  assert.equal(binding.operations.screenRecordingStart, undefined);
  assert.equal(binding.operations.appLogInspect, undefined);
});

test('a session that has ended reports the refused facts and binds no device action', async () => {
  const facts = await owner({ hasLiveSession: false }).inspectFacts(IOS_DEVICE);
  assert.equal(facts?.operations.captureSnapshot.available, false);
  assert.equal(facts?.operations.openApplication.available, false);
  assert.equal(facts?.operations.tapPoint.available, false);
});

test('a binding whose facts refused everything exposes no operation at all', async () => {
  // The exact-owner intent binds even without a live session so `inspectFacts` and `bind` cannot
  // disagree, so the operations projection has to follow those facts. An operation left bound here
  // would reach an interactor for a session that is gone.
  const binding = await bind(
    owner({ hasLiveSession: false, interactor: { tap: async () => {} } as unknown as Interactor }),
  );
  assert.deepEqual(Object.keys(binding.operations), []);
});

test('a device identity this module never built is refused at bind', async () => {
  const foreign: DeviceInfo = { ...IOS_DEVICE, id: 'other:ios:lease-1' };
  await assert.rejects(
    owner({ hasLiveSession: true }).bind({
      device: foreign,
      intent: { kind: 'exact-owner', owner: OWNER },
      scope: { signal: new AbortController().signal },
    } as never),
    (error: unknown) => error instanceof AppError && error.code === 'UNSUPPORTED_PLATFORM',
  );
});

test('a facts inspection of an unowned device reports the target refusal, not a session one', async () => {
  const foreign: DeviceInfo = { ...IOS_DEVICE, id: 'other:ios:lease-1' };
  const facts = await owner({ hasLiveSession: true }).inspectFacts(foreign);
  assert.equal(facts?.operations.openApplication.available, false);
  assert.equal(facts?.operations.openApplication.reason, 'unsupported-provider-mode');
});

/** A session whose installs succeed without naming the app, so the materializer's reading shows. */
function installingSession(installs: string[]): RevylDeploymentSession {
  const client = {
    createSessionArtifactUpload: async () => ({
      upload_url: 'https://storage.test/put',
      download_url: 'https://storage.test/get',
    }),
    uploadSessionArtifact: async () => undefined,
    startInstall: async (_runId: string, body: { app_url: string }) => {
      installs.push(body.app_url);
      return { install_id: 'install-1', status: 'accepted' };
    },
    getInstallStatus: async () => ({ status: 'completed', result: { success: true } }),
  } as unknown as RevylClient;
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    platform: 'ios',
    client,
  };
}

test('a live session installs a build through its deployment operations', async () => {
  const dir = await mkdtempForTest('revyl-platform-deploy-');
  const build = path.join(dir, 'Example.zip');
  await fs.writeFile(build, 'zip');
  const artifact: MaterializedAppSource = {
    installablePath: build,
    bundleId: 'com.example.app',
    appName: 'Example',
    cleanup: async () => undefined,
  };
  const installs: string[] = [];
  const binding = await bind(
    owner({
      hasLiveSession: true,
      deploymentSession: installingSession(installs),
      host: {
        ...HOST,
        hostEnvironment: { env: {}, cwd: dir },
        appleDeployment: { prepareArtifact: async () => artifact },
      } as unknown as PlatformRuntimeHost,
    }),
  );

  const materialized = await binding.operations.materializeAppSource!({
    source: { kind: 'url', url: 'https://apps.test/Example.zip' },
  });
  assert.equal(materialized, artifact);
  assert.deepEqual(await binding.operations.deployMaterializedApp!({ artifact }), {
    bundleId: 'com.example.app',
    appName: 'Example',
    launchTarget: 'com.example.app',
  });
  assert.deepEqual(
    await binding.operations.deployApp!({
      app: 'com.example.app',
      appPath: build,
      replaceExisting: false,
    }),
    {},
  );
  assert.deepEqual(installs, ['https://storage.test/get', 'https://storage.test/get']);
});

test('a deployment operation whose session ended refuses rather than installing', async () => {
  const binding = await bind(owner({ hasLiveSession: true }));
  await assert.rejects(
    () =>
      binding.operations.deployApp!({
        app: 'com.example.app',
        appPath: '/tmp/x.zip',
        replaceExisting: false,
      }),
    (error: unknown) =>
      error instanceof AppError && error.details?.reason === 'provider-session-unavailable',
  );
});
