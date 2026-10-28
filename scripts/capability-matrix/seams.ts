// The host and wire seams the matrix reads its facts through.
//
// `inspectFacts` is a pure decision over a device record plus the host and
// provider seams the daemon injects. Feeding it a stub host and a scripted
// provider wire means the matrix reports what the code decides, with no device,
// no daemon, no credentials, and no network. Nothing here talks to a provider.

import moduleHooks from 'node:module';
import { createAgentBrowserWebProvider, withWebProvider } from '@agent-device/platform-web';
import { createWebInteractor } from '@agent-device/platform-web/interactor';
import type { RunHostCommand } from '@agent-device/provider-webdriver';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { resolveWebNetworkTransport } from '../../src/platform-runtime-network-web-transport.ts';
import { createAppleScreenRecordingHost } from '../../src/platform-runtime-screen-recording-apple-host.ts';
import { resolveWebScreenRecordingTransport } from '../../src/platform-runtime-screen-recording-web-host.ts';

/**
 * A value for a host seam the matrix never reads a fact through. Reading or
 * calling it fails the run, so a runtime that starts deciding a cell from a new
 * seam cannot silently read a fabricated answer; the seam gets a real entry
 * below instead. `then` is absent so awaiting one of these does not hang.
 */
function inert(pathname: string): unknown {
  const refused = (name: string): never => {
    throw new Error(
      `Fact collection reached the undeclared host seam ${name}. ` +
        'Declare what the seam answers for facts, or keep the fact path off it.',
    );
  };
  return new Proxy(function () {}, {
    get: (_target, key) => {
      if (key === 'then' || key === 'inspect' || typeof key === 'symbol') return undefined;
      return new Proxy(function () {}, {
        get: () => refused(`${pathname}.${String(key)}`),
        apply: () => refused(`${pathname}.${String(key)}()`),
      });
    },
    apply: () => refused(`${pathname}()`),
  });
}

// The daemon answers web facts through the agent-browser provider it composes
// into every web request (src/platform-runtime/request-providers.ts); the seam
// builds the same provider, so the provider's own surface decides each cell.
async function matrixWebProvider() {
  return await createAgentBrowserWebProvider({ host: HOST_ENVIRONMENT });
}

const HOST_ENVIRONMENT: HostEnvironment = { env: {} } as unknown as HostEnvironment;

const localProcessTransport = Object.freeze({
  mode: 'local' as const,
  start: async (): Promise<never> => {
    throw new Error('Fact collection does not start app-log processes.');
  },
});

/**
 * The host every runtime loads against. Seams a fact reads answer for real:
 * an empty environment (so no provider credential is ever present), an Apple
 * recording availability read through the production transport resolvers, a web
 * network transport through the production web resolver, a web recording
 * transport built from the same agent-browser provider the daemon composes, a
 * web interactor through the production web interactor factory, and the local
 * app-log process transport the daemon hands every non-Android device and the
 * unscoped Android path alike. The Android clipboard probe answers the AOSP
 * behaviour the row's note marks; no real device backs it. Every other seam is
 * inert, and reading one fails the run.
 */
export function createStubHost(): PlatformRuntimeHost {
  const real = {
    hostEnvironment: HOST_ENVIRONMENT,
    androidTools: { probeClipboardShellSupport: async () => 'supported' as const },
    processTransports: { resolve: async () => localProcessTransport },
    networkTransports: {
      // Scoped exactly like the web recording seam: inside a web request the
      // daemon's default provider is scoped, and the production resolver reads
      // that scope to choose its mode, so the fact must be collected the same way.
      resolve: async (device: Parameters<typeof resolveWebNetworkTransport>[0]) =>
        await withWebProvider(await matrixWebProvider(), () =>
          resolveWebNetworkTransport(device, HOST_ENVIRONMENT),
        ),
    },
    screenRecording: {
      apple: {
        // The production host composer owns the simulator-vs-runner split, so a
        // change to it moves this column instead of silently disagreeing with it.
        availability: createAppleScreenRecordingHost(HOST_ENVIRONMENT).availability,
      },
      web: {
        // Inside a web request the daemon scopes its default provider, so the
        // matrix scopes it the same way before asking the production resolver.
        resolve: async (device: Parameters<typeof resolveWebScreenRecordingTransport>[0]) =>
          await withWebProvider(await matrixWebProvider(), () =>
            resolveWebScreenRecordingTransport(device),
          ),
      },
    },
    localInteractors: {
      // The production web plugin path: the factory composes the default
      // agent-browser provider from this host when none is scoped.
      resolve: async () => await createWebInteractor(HOST_ENVIRONMENT),
    },
  };
  return new Proxy(real, {
    get: (target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      if (key in target) return (target as Record<string, unknown>)[key];
      return inert(String(key));
    },
    has: () => true,
  }) as unknown as PlatformRuntimeHost;
}

/**
 * One host for every collection, whatever machine runs the generator. The
 * system-audio fact reads `process.platform`, so an unpinned run on Linux would
 * report a different page than the same commit on macOS. Apple simulator,
 * Android emulator, and macOS desktop audio are macOS-host capabilities, and the
 * page says so, so the matrix collects as if the agent host is macOS.
 */
export const MATRIX_HOST_PLATFORM: NodeJS.Platform = 'darwin';

// The Limrun SDK is a real third-party package. Facts must not reach it, so a
// module loader replaces its three entry points with data-URL modules before
// anything imports the Limrun provider. `module.register` reaches back to Node
// 20.6, so the stubbing works on the repository's supported Node floor; the
// loader is registered before the provider's first import resolves, which is
// why the collector imports the provider only after calling this.
const limrunSdkStub = `
export default class Limrun {
  iosInstances = { create: async () => ({ metadata: { id: 'limrun-instance' }, status: {} }), list: async () => [], delete: async () => {} };
  androidInstances = { create: async () => ({ metadata: { id: 'limrun-instance' }, status: {} }), list: async () => [], delete: async () => {} };
  assets = { getOrUpload: async () => ({}), list: async () => [] };
}
export class NotFoundError extends Error {}
`;

const limrunInstanceClientStub = `
const handlers = {
  deviceInfo: { screenWidth: 393, screenHeight: 852 },
  disconnect: async () => {},
  elementTree: async () => ({ type: 'Application', children: [] }),
};
export const createInstanceClient = async () => handlers;
export default { createInstanceClient };
`;

const LIMRUN_STUBS: ReadonlyMap<string, string> = new Map([
  ['@limrun/api', limrunSdkStub],
  ['@limrun/api/ios-client', limrunInstanceClientStub],
  ['@limrun/api/instance-client', limrunInstanceClientStub],
]);

// The loader runs on Node's module-loading thread and receives the stub table
// as transfer data. An SDK entry with no stub fails the load instead of
// resolving the real package, so a new import inside the provider cannot
// silently reach the network.
const limrunStubLoader = `
let stubs = new Map();
export async function initialize(data) {
  stubs = new Map(data.stubs);
}
export function resolve(specifier, context, nextResolve) {
  if (specifier === '@limrun/api' || specifier.startsWith('@limrun/api/')) {
    const stub = stubs.get(specifier);
    if (stub === undefined) {
      throw new Error(
        'The Limrun SDK entry "' + specifier + '" has no stub, so facts would reach the real SDK. ' +
          'Add a stub to LIMRUN_STUBS in scripts/capability-matrix/seams.ts.',
      );
    }
    return {
      url: 'data:text/javascript,' + encodeURIComponent(stub),
      shortCircuit: true,
      format: 'module',
    };
  }
  return nextResolve(specifier, context);
}
`;

/**
 * Replace the Limrun SDK with stubs for every later `import` in this process.
 * The specifier must match exactly; an unstubbed SDK specifier fails to load.
 */
export function stubLimrunSdk(): void {
  if (!moduleHooks.register) {
    throw new Error(
      'node:module register is unavailable, so the Limrun SDK cannot be stubbed. ' +
        'Run the collector on the repository-supported Node (22.12 or later).',
    );
  }
  moduleHooks.register(
    `data:text/javascript,${encodeURIComponent(limrunStubLoader)}`,
    import.meta.url,
    { data: { stubs: [...LIMRUN_STUBS.entries()] } },
  );
}

export type ProviderWire = Readonly<{
  /** Answers every WebDriver request the cloud runtimes send. */
  fetch: typeof fetch;
  /** Answers every AWS CLI call the AWS Device Farm runtime spawns. */
  runHostCommand: RunHostCommand;
}>;

const WAREHOUSE_UPLOAD = { app_url: 'bs://uploaded', value: { lt_upload_key: 'lt://uploaded' } };
const NEW_SESSION = { value: { sessionId: 'provider-session-1', capabilities: {} } };

const REMOTE_ACCESS_SESSION = {
  arn: 'arn:aws:devicefarm:us-west-2:123456789012:remoteaccesssession/example',
  status: 'RUNNING',
  endpoints: { appium: 'https://device-farm.test/wd/hub' },
  device: { name: 'Pixel 8', platform: 'ANDROID', os: '14' },
};

function awsCliOutput(args: readonly string[]): unknown {
  const subcommand = args[1];
  if (subcommand === 'create-remote-access-session') {
    return { remoteAccessSession: { arn: REMOTE_ACCESS_SESSION.arn, status: 'PENDING' } };
  }
  if (subcommand === 'get-remote-access-session')
    return { remoteAccessSession: REMOTE_ACCESS_SESSION };
  return { remoteAccessSession: { arn: REMOTE_ACCESS_SESSION.arn, status: 'STOPPING' } };
}

/** A scripted provider wire: uploads return a stored app, session create returns a session id. */
export function createProviderWire(): ProviderWire {
  return {
    fetch: (async (input: unknown, init?: RequestInit) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, '');
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const value = path.includes('upload')
        ? WAREHOUSE_UPLOAD
        : body?.capabilities
          ? NEW_SESSION
          : {};
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    runHostCommand: async (_command: string, args: readonly string[]) => ({
      stdout: JSON.stringify(awsCliOutput(args)),
    }),
  };
}

/**
 * The credentials a provider probe needs to get as far as its wire. They are
 * fixed placeholders, never read from the environment, so the matrix says the
 * same thing on every machine.
 */
export const PROVIDER_ENV: Readonly<Record<string, string>> = {
  BROWSERSTACK_USERNAME: 'provider-user',
  BROWSERSTACK_ACCESS_KEY: 'provider-key',
  LT_USERNAME: 'provider-user',
  LT_ACCESS_KEY: 'provider-key',
  AWS_REGION: 'us-west-2',
  LIMRUN_API_KEY: 'provider-key',
};
