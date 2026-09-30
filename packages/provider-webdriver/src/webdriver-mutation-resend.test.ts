import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  countDiagnosticEventsByPhase,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { AppError } from '@agent-device/kernel/errors';
import { createCloudWebDriverCapabilities } from './capabilities.ts';
import { WebDriverClient } from './webdriver-client.ts';
import { createWebDriverInteractor } from './webdriver-interactor.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * The route a request addresses: the `mobile:` script name for `POST .../execute/sync`, otherwise
 * the method and path with the session id replaced by `:id`.
 */
function routeOf(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? 'GET';
  const pathname = url.pathname
    .replace(/^\/wd\/hub/, '')
    .replace(/^\/session\/wd-1/, '/session/:id');
  if (pathname.endsWith('/execute/sync') && typeof init?.body === 'string') {
    return (JSON.parse(init.body) as { script: string }).script;
  }
  return `${method} ${pathname}`;
}

/**
 * A grid that never answers `hangRoute` until the transport's own timeout aborts it, answers
 * `unsupportedRoute` with a W3C 404, and answers every other route immediately. A hung request is
 * the shape a slow driver takes on a real provider: it received the request and is still working
 * on it.
 */
function hangingWebDriverFetch(
  hangRoute: string,
  unsupportedRoute?: string,
  unsupportedErrorCode = 'unknown command',
): { fetch: typeof globalThis.fetch; sendsTo: (route: string) => number } {
  const routes: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const route = routeOf(input, init);
    routes.push(route);
    if (route === hangRoute) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    }
    if (route === 'POST /session') {
      return Response.json({ value: { sessionId: 'wd-1', capabilities: {} } });
    }
    if (route === unsupportedRoute) {
      return Response.json(
        { value: { error: unsupportedErrorCode, message: 'refused' } },
        { status: 404 },
      );
    }
    return Response.json({ value: null });
  };
  return { fetch, sendsTo: (route) => routes.filter((sent) => sent === route).length };
}

/**
 * A real `WebDriverClient` and `createWebDriverInteractor` over the hanging grid. The default
 * transport policy retries once, so a request that is resent shows two sends.
 */
async function connectedWebDriverInteractor(options: {
  hangRoute: string;
  unsupportedRoute?: string;
  unsupportedErrorCode?: string;
  createSession?: boolean;
}) {
  const { fetch, sendsTo } = hangingWebDriverFetch(
    options.hangRoute,
    options.unsupportedRoute,
    options.unsupportedErrorCode,
  );
  globalThis.fetch = fetch;
  const client = new WebDriverClient({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 20, retryDelayMs: 5, sessionCreateTimeoutMs: 20 },
  });
  if (options.createSession !== false) await client.createSession({ platformName: 'Android' });
  const interactor = createWebDriverInteractor({
    client,
    backend: 'android',
    capabilities: createCloudWebDriverCapabilities({
      provider: 'test',
      platform: 'android',
      overrides: {
        home: 'supported',
        'clipboard.read': 'supported',
        'clipboard.write': 'supported',
      },
    }),
  });
  return { client, interactor, sendsTo };
}

type Connected = Awaited<ReturnType<typeof connectedWebDriverInteractor>>;

type MutatingRouteRow = {
  act: (connected: Connected) => Promise<unknown>;
  /** A route the grid answers as unsupported so `act` reaches the hung sibling route. */
  unsupportedRoute?: string;
  createSession?: false;
};

const MUTATING_ROUTES: Record<string, MutatingRouteRow> = {
  'POST /session': {
    act: ({ client }) => client.createSession({ platformName: 'Android' }),
    createSession: false,
  },
  'DELETE /session/:id': { act: ({ client }) => client.deleteSession() },
  'POST /session/:id/appium/device/install_app': {
    act: ({ client }) => client.installApp('/tmp/app.apk'),
  },
  'POST /session/:id/appium/device/activate_app': {
    act: ({ client }) => client.activateApp('com.example.app'),
  },
  'POST /session/:id/appium/device/terminate_app': {
    act: ({ client }) => client.terminateApp('com.example.app'),
  },
  'POST /session/:id/appium/device/hide_keyboard': { act: ({ client }) => client.hideKeyboard() },
  'POST /session/:id/actions': { act: ({ interactor }) => interactor.tap(10, 20) },
  'DELETE /session/:id/actions': { act: ({ client }) => client.releaseActions() },
  'POST /session/:id/keys': { act: ({ client }) => client.sendKeys('hello') },
  'POST /session/:id/back': { act: ({ interactor }) => interactor.back() },
  'POST /session/:id/rotation': { act: ({ client }) => client.setRotation(90) },
  'POST /session/:id/orientation': { act: ({ client }) => client.setOrientation('LANDSCAPE') },
  'mobile: deepLink': {
    act: ({ interactor }) => interactor.open('com.example.app', { url: 'example://home' }),
  },
  'mobile: activateApp': { act: ({ interactor }) => interactor.openDevice() },
  'mobile: terminateApp': {
    act: ({ client }) => client.terminateApp('com.example.app'),
    unsupportedRoute: 'POST /session/:id/appium/device/terminate_app',
  },
  'mobile: pressButton': {
    act: async ({ interactor }) => {
      assert.ok(interactor.home);
      await interactor.home();
    },
  },
  'mobile: setClipboard': {
    act: async ({ interactor }) => {
      assert.ok(interactor.writeClipboard);
      await interactor.writeClipboard('copied');
    },
  },
};

/**
 * Every mutating route the provider sends, read from its source: each non-GET client request, and
 * each `mobile:` script passed to `executeScript`. `POST .../execute/sync` itself is the carrier
 * of the `mobile:` scripts, which are enumerated by name.
 */
function mutatingRoutesInSource(): string[] {
  const sourceDir = path.dirname(new URL(import.meta.url).pathname);
  const routes = new Set<string>();
  for (const file of fs.readdirSync(sourceDir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = fs.readFileSync(path.join(sourceDir, file), 'utf8');
    for (const match of source.matchAll(
      /(sessionRequest|requestValue)\(\s*'(POST|PUT|PATCH|DELETE)',\s*[`']([^`']+)[`']/g,
    )) {
      const [, helper, method, routePath] = match;
      const absolute = helper === 'sessionRequest' ? `/session/:id${routePath}` : routePath;
      const route = `${method} ${absolute!.replace('${sessionId}', ':id')}`;
      if (route !== 'POST /session/:id/execute/sync') routes.add(route);
    }
    for (const match of source.matchAll(/\.executeScript\(\s*'(mobile: \w+)'/g)) {
      routes.add(match[1]!);
    }
  }
  return [...routes].sort();
}

test('the mutating-route table covers every mutating route the provider sends', () => {
  assert.deepEqual(Object.keys(MUTATING_ROUTES).sort(), mutatingRoutesInSource());
});

// A resend after a timeout cannot tell whether the first attempt's side effect already landed, so
// every mutating route gets one send and discloses that its outcome is unresolved.
for (const [route, row] of Object.entries(MUTATING_ROUTES)) {
  test(`a timed-out ${route} is sent once`, async () => {
    const connected = await connectedWebDriverInteractor({
      hangRoute: route,
      unsupportedRoute: row.unsupportedRoute,
      createSession: row.createSession,
    });

    await assert.rejects(row.act(connected), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.dispatched, 'unknown');
      return true;
    });

    assert.equal(connected.sendsTo(route), 1);
  });
}

test('a timed-out GET read is resent once', async () => {
  const { interactor, sendsTo } = await connectedWebDriverInteractor({
    hangRoute: 'GET /session/:id/source',
  });

  await assert.rejects(interactor.snapshot(), () => true);

  assert.equal(sendsTo('GET /session/:id/source'), 2);
});

test('a timed-out mobile: getClipboard read is resent once', async () => {
  const { interactor, sendsTo } = await connectedWebDriverInteractor({
    hangRoute: 'mobile: getClipboard',
  });

  assert.ok(interactor.readClipboard);
  await assert.rejects(interactor.readClipboard(), () => true);

  assert.equal(sendsTo('mobile: getClipboard'), 2);
});

// App activation has a sibling route (`mobile: activateApp`) for drivers without the Appium one.
// A timeout on the first route is not "unsupported": the driver may already be activating the app,
// so switching routes would send the mutation twice.
test('a timed-out app activation does not fall back to the sibling route', async () => {
  const { client, sendsTo } = await connectedWebDriverInteractor({
    hangRoute: 'POST /session/:id/appium/device/activate_app',
  });

  await assert.rejects(client.activateApp('com.example.app'), () => true);

  assert.equal(sendsTo('mobile: activateApp'), 0);
});

// A driver that answers the first route with "unknown command" never ran it, so the sibling route
// is the one attempt that reaches the device.
test('an unsupported app-termination route falls back to the sibling route once', async () => {
  const { client, sendsTo } = await connectedWebDriverInteractor({
    hangRoute: 'none',
    unsupportedRoute: 'POST /session/:id/appium/device/terminate_app',
  });

  await withDiagnosticsScope({ command: 'close' }, async () => {
    await client.terminateApp('com.example.app');
    await vi.waitFor(() =>
      assert.equal(countDiagnosticEventsByPhase(['webdriver_route_unsupported']), 1),
    );
  });

  assert.equal(sendsTo('POST /session/:id/appium/device/terminate_app'), 1);
  assert.equal(sendsTo('mobile: terminateApp'), 1);
});

// W3C also answers 404 for a session that no longer exists. That is not an unsupported route, so
// the sibling route is not tried and the failure is not classified as never dispatched here.
test('a 404 naming another W3C error does not fall back to the sibling route', async () => {
  const { client, sendsTo } = await connectedWebDriverInteractor({
    hangRoute: 'none',
    unsupportedRoute: 'POST /session/:id/appium/device/terminate_app',
    unsupportedErrorCode: 'invalid session id',
  });

  await assert.rejects(client.terminateApp('com.example.app'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.dispatched, undefined);
    return true;
  });

  assert.equal(sendsTo('POST /session/:id/appium/device/terminate_app'), 1);
  assert.equal(sendsTo('mobile: terminateApp'), 0);
});
