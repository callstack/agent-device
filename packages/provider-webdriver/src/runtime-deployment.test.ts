import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createBrowserStackUploadApp } from './browserstack.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';
import { createWebDriverDeploymentRuntime } from './runtime-deployment.ts';
import type { WebDriverProviderSession } from './runtime-session.ts';
import type { CloudWebDriverUploadApp } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'webdriver:stale',
  name: 'Stale WebDriver device',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

const iosDevice: DeviceInfo = { ...device, platform: 'apple', id: 'webdriver:ios' };
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('keeps a stale WebDriver owner unavailable before any deployment attempt', () => {
  const deployment = createWebDriverDeploymentRuntime({
    provider: 'webdriver-test',
    findSessionForDevice: () => undefined,
  });

  expect(deployment.fact(device)).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
  });
});

test('aborts a WebDriver provider deployment while its upload is in flight', async () => {
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during provider upload');
  const installApp = vi.fn(async () => undefined);
  const uploadApp: CloudWebDriverUploadApp = vi.fn(async (params) => {
    expect(params.signal).toBe(controller.signal);
    return await rejectWhenAborted(params.signal);
  });
  const deployment = createWebDriverDeploymentRuntime({
    provider: 'webdriver-test',
    uploadApp,
    findSessionForDevice: () => activeSession(installApp),
  });

  const pending = deployment.deployApp(
    device,
    { app: 'com.example.app', appPath: '/tmp/App.apk', replaceExisting: false },
    controller.signal,
  );
  controller.abort(abortReason);

  await expect(pending).rejects.toBe(abortReason);
  expect(installApp).not.toHaveBeenCalled();
});

test('aborts a WebDriver provider deployment while its install is in flight', async () => {
  const controller = new AbortController();
  const abortReason = new Error('request cancelled during provider install');
  const installApp = vi.fn(async (_appPath: string, signal?: AbortSignal) => {
    expect(signal).toBe(controller.signal);
    return await rejectWhenAborted(signal);
  });
  const deployment = createWebDriverDeploymentRuntime({
    provider: 'webdriver-test',
    uploadApp: async () => ({ appReference: 'bs://uploaded-app' }),
    findSessionForDevice: () => activeSession(installApp),
  });

  const pending = deployment.deployApp(
    device,
    { app: 'com.example.app', appPath: '/tmp/App.apk', replaceExisting: false },
    controller.signal,
  );
  controller.abort(abortReason);

  await expect(pending).rejects.toBe(abortReason);
  expect(installApp).toHaveBeenCalledWith('bs://uploaded-app', controller.signal);
});

// The materializer knows which file carries the build; the deployment runtime must not second-guess
// it from extensions, or a URL zip wrapping an .ipa would upload the wrapper.
test('a hosted upload sends the file the materializer names, else the installable', async () => {
  const uploaded: string[] = [];
  const installApp = vi.fn(async () => undefined);
  const deployment = createWebDriverDeploymentRuntime({
    provider: 'webdriver-test',
    uploadApp: async ({ appPath }) => {
      uploaded.push(appPath);
      return { appReference: `hub://${uploaded.length}` };
    },
    findSessionForDevice: () => activeSession(installApp),
  });
  const deploy = async (selected: DeviceInfo, artifact: Record<string, string | undefined>) =>
    await deployment.deployMaterializedApp(
      selected,
      { artifact: { installablePath: '', ...artifact, cleanup: async () => {} } },
      new AbortController().signal,
    );

  const result = await deploy(iosDevice, {
    archivePath: '/m/App.app.zip',
    installablePath: '/m/extracted/App.app',
    uploadPath: '/m/App.app.zip',
    bundleId: 'com.example.app',
  });
  await deploy(iosDevice, {
    archivePath: '/m/wrapper.zip',
    installablePath: '/m/x/Payload/App.app',
    uploadPath: '/m/x/App.ipa',
  });
  await deploy(iosDevice, { archivePath: '/m/App.tar.gz', installablePath: '/m/x/App.app' });
  await deploy(device, { archivePath: '/m/build.zip', installablePath: '/m/x/app.apk' });

  expect(uploaded).toEqual(['/m/App.app.zip', '/m/x/App.ipa', '/m/x/App.app', '/m/x/app.apk']);
  expect(result).toEqual({ bundleId: 'com.example.app', launchTarget: 'com.example.app' });
  expect(installApp).toHaveBeenNthCalledWith(1, 'hub://1', expect.any(AbortSignal));
});

test('a hosted upload refuses a directory typed before any upload request', async () => {
  const tempDir = await mkdtempForTest('agent-device-materialized-directory-');
  try {
    const installablePath = path.join(tempDir, 'extracted', 'App.app');
    await fs.mkdir(installablePath, { recursive: true });
    const fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;
    const installApp = vi.fn(async () => undefined);
    const deployment = createWebDriverDeploymentRuntime({
      provider: 'browserstack',
      uploadApp: createBrowserStackUploadApp({
        clientVersion: '0.0.0-test',
        username: 'user',
        accessKey: 'key',
        endpoint: 'https://upload.example.test/app',
      }),
      findSessionForDevice: () => activeSession(installApp),
    });

    await expect(
      deployment.deployMaterializedApp(
        iosDevice,
        { artifact: { installablePath, cleanup: async () => {} } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGS',
      message: `BrowserStack can only upload a regular app file: ${installablePath}`,
      details: expect.objectContaining({ provider: 'browserstack' }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(installApp).not.toHaveBeenCalled();
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test('a provider without an uploader still installs the materialized bundle path', async () => {
  const installApp = vi.fn(async () => undefined);
  const deployment = createWebDriverDeploymentRuntime({
    provider: 'webdriver-test',
    findSessionForDevice: () => activeSession(installApp),
  });
  await deployment.deployMaterializedApp(
    iosDevice,
    {
      artifact: {
        archivePath: '/m/App.app.zip',
        installablePath: '/m/extracted/App.app',
        uploadPath: '/m/App.app.zip',
        bundleId: 'com.example.app',
        cleanup: async () => {},
      },
    },
    new AbortController().signal,
  );
  expect(installApp).toHaveBeenCalledWith('/m/extracted/App.app', expect.any(AbortSignal));
});

test('a hosted upload reads the zipped simulator build that install-from-source extracted', async () => {
  const tempDir = await mkdtempForTest('agent-device-materialized-upload-');
  try {
    const archivePath = path.join(tempDir, 'App.app.zip');
    const installablePath = path.join(tempDir, 'extracted', 'App.app');
    await fs.writeFile(archivePath, 'zip bytes');
    await fs.mkdir(installablePath, { recursive: true });
    const uploadedBytes: string[] = [];
    const installApp = vi.fn(async () => undefined);
    const deployment = createWebDriverDeploymentRuntime({
      provider: 'webdriver-test',
      uploadApp: async ({ appPath }) => {
        uploadedBytes.push(await fs.readFile(appPath, 'utf8'));
        return { appReference: 'hub://APP42' };
      },
      findSessionForDevice: () => activeSession(installApp),
    });

    await deployment.deployMaterializedApp(
      iosDevice,
      {
        artifact: {
          archivePath,
          installablePath,
          uploadPath: archivePath,
          cleanup: async () => {},
        },
      },
      new AbortController().signal,
    );

    expect(uploadedBytes).toEqual(['zip bytes']);
    expect(installApp).toHaveBeenCalledWith('hub://APP42', expect.any(AbortSignal));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function activeSession(
  installApp: (appPath: string, signal?: AbortSignal) => Promise<void>,
): WebDriverProviderSession {
  return {
    capabilities: createCloudWebDriverCapabilities({
      provider: 'webdriver-test',
      platform: 'android',
    }),
    client: { installApp },
    prepared: {},
  } as unknown as WebDriverProviderSession;
}

async function rejectWhenAborted(signal: AbortSignal | undefined): Promise<never> {
  return await new Promise<never>((_resolve, reject) => {
    if (!signal) {
      reject(new Error('provider operation was not given the binding signal'));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
