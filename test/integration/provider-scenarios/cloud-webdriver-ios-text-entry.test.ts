import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CLOUD_WEBDRIVER_PROVIDERS,
  createProviderWebDriver,
} from '@agent-device/provider-webdriver';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import { assertRpcOk } from './assertions.ts';
import {
  createProviderScenarioHarness,
  withProviderScenarioResource,
  type ProviderScenarioHarness,
} from './harness.ts';
import {
  CloudWebDriverTestServer,
  type CloudWebDriverHttpCall,
  type CloudWebDriverTestResponse,
  cloudWebDriverTestJson,
  startCloudWebDriverTestServer,
  type StartedCloudWebDriverTestServer,
} from './cloud-webdriver-test-server.ts';

const WEBDRIVER_PROVIDER = CLOUD_WEBDRIVER_PROVIDERS.browserStack;
const CLIENT_VERSION = '0.20.6-test';

/**
 * #1658: `open <bundle id>` against a cloud iOS device reported success but
 * left the session with no app identity, because the provider branch of the
 * open path skips local app resolution wholesale. Every capture then hit the
 * local runner's app-session guard and failed instantly with SESSION_NOT_FOUND
 * — no driver round trip, on a session where press/find/fill/screenshot all
 * worked.
 */
test('cloud iOS snapshot captures through the provider session after open', async () => {
  await withProviderScenarioResource(createCloudIosWorld, async ({ daemon, server }) => {
    const lease = await openCloudIosSession(daemon);

    const response = await daemon.callCommand(
      'snapshot',
      [],
      { ...leaseFlags(lease.leaseId), snapshotInteractiveOnly: true },
      { meta: leaseMeta(lease.leaseId) },
    );

    const data = assertRpcOk<{ nodes?: Array<{ label?: string; identifier?: string }> }>(response);
    assert.equal(
      data.nodes?.some((node) => node.identifier === 'email'),
      true,
    );
    // The capture went to the provider's driver, not to a local runner.
    assert.equal(
      server.calls.some(
        (call) => call.method === 'GET' && call.path === '/wd/hub/session/wd-1/source',
      ),
      true,
    );
    // The explicit bundle id is the one identity a cloud open can adopt without
    // local tooling, so the session keeps it for every appBundleId-gated command.
    assert.equal(daemon.session()?.appBundleId, 'com.example.demo');
  });
}, 15_000);

/**
 * #1658: `fill` tapped and sent its keys back-to-back. A WebView input takes
 * first responder asynchronously, so the keys arrived with nothing focused and
 * the command still answered "Filled N chars" — which is why tapping and
 * filling as two separate commands was the only reliable route.
 *
 * The device model, not just the request order, is what makes this a
 * regression test: the fake drops keys that arrive while the keyboard is down,
 * exactly as an unfocused field does, so the assertion below is the field's own
 * value.
 */
test('cloud iOS fill lands text in the field it tapped', async () => {
  await withProviderScenarioResource(createCloudIosWorld, async ({ daemon, server }) => {
    const lease = await openCloudIosSession(daemon);

    const response = await daemon.callCommand(
      'fill',
      ['editable=true', 'user@example.com'],
      leaseFlags(lease.leaseId),
      { meta: leaseMeta(lease.leaseId) },
    );

    const data = assertRpcOk<{ text?: string; textEntryReadiness?: string }>(response);
    assert.equal(data.text, 'user@example.com');
    assert.equal(data.textEntryReadiness, 'keyboard-shown');
    // The keys reached the focused field, not the void.
    assert.equal(server.fieldValue, 'user@example.com');
    assert.deepEqual(textEntryTranscript(server), ['keyboard', 'tap', 'keyboard', 'keys']);

    // And the device agrees: the field reports the typed value back.
    const snapshot = await daemon.callCommand(
      'snapshot',
      [],
      { ...leaseFlags(lease.leaseId), snapshotInteractiveOnly: true },
      { meta: leaseMeta(lease.leaseId) },
    );
    const nodes = assertRpcOk<{ nodes?: Array<{ identifier?: string; value?: string }> }>(
      snapshot,
    ).nodes;
    assert.equal(nodes?.find((node) => node.identifier === 'email')?.value, 'user@example.com');
  });
}, 15_000);

/**
 * #1658 again, from the other side: when the tap raises no keyboard at all,
 * nothing focused a field and `sendKeys` would go nowhere. Answering that with
 * "Filled N chars" is the original bug, so the fill refuses — and sends no keys,
 * leaving the field untouched rather than half-written.
 */
test('cloud iOS fill refuses, without typing, when the tap raises no keyboard', async () => {
  await withProviderScenarioResource(createCloudIosWorld, async ({ daemon, server }) => {
    const lease = await openCloudIosSession(daemon);
    server.keyboardPollsUntilShown = Number.POSITIVE_INFINITY;

    const response = await daemon.callCommand(
      'fill',
      ['editable=true', 'user@example.com'],
      leaseFlags(lease.leaseId),
      { meta: leaseMeta(lease.leaseId) },
    );

    const error = response.json.error;
    assert.ok(error, 'expected fill to refuse');
    assert.match(error.message ?? '', /no keyboard appeared, so the text was not sent/);
    assert.equal(error.data?.details?.reason, 'text_entry_focus_not_observed');
    assert.equal(server.fieldValue, '');
    assert.equal(textEntryTranscript(server).includes('keys'), false);
  });
}, 15_000);

/** The tap/keys/keyboard requests in the order the driver received them. */
function textEntryTranscript(server: FakeIosWebDriverServer): string[] {
  const labels: Record<string, string> = {
    'POST /wd/hub/session/wd-1/actions': 'tap',
    'POST /wd/hub/session/wd-1/keys': 'keys',
    'GET /wd/hub/session/wd-1/appium/device/is_keyboard_shown': 'keyboard',
  };
  return server.calls
    .map((call) => labels[`${call.method} ${call.path}`])
    .filter((label): label is string => label !== undefined);
}

async function createCloudIosWorld() {
  const server = await FakeIosWebDriverServer.start();
  const providerWebDriver = createProviderWebDriver({
    clientVersion: CLIENT_VERSION,
    runHostCommand: async () => {
      throw new Error('BrowserStack scenario must not run host commands');
    },
  });
  const runtimes = providerWebDriver.createDefaultRuntimes({
    BROWSERSTACK_USERNAME: 'browser-user',
    BROWSERSTACK_ACCESS_KEY: 'browser-key',
    BROWSERSTACK_WEBDRIVER_ENDPOINT: `${server.url}/wd/hub/`,
    BROWSERSTACK_SESSION_DETAILS_ENDPOINT: `${server.url}/app-automate/sessions`,
  });
  const providers = createProviderDeviceRuntimeRequestProviders(runtimes);
  const daemon = await createProviderScenarioHarness({
    ...providers,
    deviceInventoryProvider: providers.deviceInventoryProvider!,
  });
  return {
    daemon,
    server,
    close: async () => {
      await Promise.allSettled(runtimes.map(async (runtime) => await runtime.shutdown()));
      await daemon.close();
      await server.close();
    },
  };
}

/** Allocates the provider lease and opens the app by bundle id, as `connect` + `open` do. */
async function openCloudIosSession(daemon: ProviderScenarioHarness): Promise<DeviceLease> {
  const allocate = await daemon.callCommand('lease_allocate', [], leaseFlags(), {
    meta: leaseMeta(),
  });
  const { lease } = assertRpcOk<{ lease: DeviceLease }>(allocate);
  const open = await daemon.callCommand('open', ['com.example.demo'], leaseFlags(lease.leaseId), {
    meta: leaseMeta(lease.leaseId),
  });
  assertRpcOk(open);
  return lease;
}

/**
 * A device model, not just a request recorder: the field takes focus a beat
 * after the tap (as a WebView input does), the keyboard follows focus, and
 * `POST /keys` — which the real driver routes to whatever holds first responder
 * — writes the field only while it is focused, and silently succeeds otherwise.
 * That last part is the #1658 bug reproduced faithfully: keys sent too early
 * are accepted by the grid and dropped by the device.
 */
class FakeIosWebDriverServer extends CloudWebDriverTestServer {
  /** How many keyboard probes after the tap before focus lands. Infinity = the tap missed. */
  keyboardPollsUntilShown = 1;
  fieldValue = '';

  private pollsRemaining = Number.POSITIVE_INFINITY;

  static async start(): Promise<StartedCloudWebDriverTestServer<FakeIosWebDriverServer>> {
    return await startCloudWebDriverTestServer(new FakeIosWebDriverServer());
  }

  protected respond(call: CloudWebDriverHttpCall) {
    const route = this.routes[`${call.method} ${call.path}`];
    return route ? route() : cloudWebDriverTestJson({ value: null });
  }

  private get routes(): Record<string, () => CloudWebDriverTestResponse> {
    return {
      'POST /wd/hub/session': () =>
        cloudWebDriverTestJson({
          value: { sessionId: 'wd-1', capabilities: { platformName: 'iOS' } },
        }),
      'GET /wd/hub/session/wd-1/source': () => cloudWebDriverTestJson({ value: this.source() }),
      'GET /wd/hub/session/wd-1/window/rect': () =>
        cloudWebDriverTestJson({ value: { x: 0, y: 0, width: 390, height: 844 } }),
      'POST /wd/hub/session/wd-1/actions': () => this.tap(),
      'POST /wd/hub/session/wd-1/keys': () => this.sendKeys(),
      'GET /wd/hub/session/wd-1/appium/device/is_keyboard_shown': () =>
        cloudWebDriverTestJson({ value: this.keyboardShown() }),
    };
  }

  private tap(): CloudWebDriverTestResponse {
    this.pollsRemaining = this.keyboardPollsUntilShown;
    return cloudWebDriverTestJson({ value: null });
  }

  /** Focus is not instant: it lands only after the configured number of probes. */
  private keyboardShown(): boolean {
    if (this.pollsRemaining <= 0) return true;
    this.pollsRemaining -= 1;
    return this.pollsRemaining <= 0;
  }

  private sendKeys(): CloudWebDriverTestResponse {
    // Unfocused keys are accepted by the grid and land nowhere — the bug's shape.
    if (this.pollsRemaining <= 0) {
      const text = this.lastSentKeys();
      if (text !== undefined) this.fieldValue = text;
    }
    return cloudWebDriverTestJson({ value: null });
  }

  private lastSentKeys(): string | undefined {
    const body = this.calls.at(-1)?.body as { value?: unknown } | undefined;
    return Array.isArray(body?.value) ? body.value.join('') : undefined;
  }

  private source(): string {
    return (
      '<XCUIElementTypeApplication name="Demo" x="0" y="0" width="390" height="844" visible="true">' +
      `<XCUIElementTypeTextField name="email" label="Email" value="${this.fieldValue}" ` +
      'x="20" y="300" width="350" height="44" visible="true" enabled="true" />' +
      '</XCUIElementTypeApplication>'
    );
  }
}

function leaseFlags(leaseId?: string): DaemonRequest['flags'] {
  return {
    platform: 'ios',
    tenant: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseProvider: WEBDRIVER_PROVIDER,
    device: 'iPhone 16',
    providerApp: 'bs://app-id',
    providerOsVersion: '18',
    providerProject: 'agent-device',
    providerBuild: 'run-a',
    providerSessionName: leaseId,
  };
}

function leaseMeta(leaseId?: string): DaemonRequest['meta'] {
  return {
    tenantId: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseBackend: 'ios-instance',
    leaseProvider: WEBDRIVER_PROVIDER,
    deviceKey: 'webdriver-ios-a',
    clientId: 'client-a',
  };
}
