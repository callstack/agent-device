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
    // Focus lands a poll late, as a WebView input's does. The keys must wait.
    server.pollsUntilFocus = 2;

    const response = await daemon.callCommand(
      'fill',
      ['label=Email', 'user@example.com'],
      leaseFlags(lease.leaseId),
      { meta: leaseMeta(lease.leaseId) },
    );

    const data = assertRpcOk<{ text?: string; textEntryReadiness?: string }>(response);
    assert.equal(data.text, 'user@example.com');
    assert.equal(data.textEntryReadiness, 'focused-element');
    // The keys reached the focused field, not the void.
    assert.equal(server.fieldValues.email, 'user@example.com');
    // Both pre-tap readings, the tap, then polling until focus lands. The keys
    // come last — that ordering IS the fix.
    assert.deepEqual(textEntryTranscript(server), [
      'keyboard',
      'active',
      'tap',
      'active',
      'active',
      'keys',
    ]);

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
test('cloud iOS fill refuses, without typing, when nothing takes focus', async () => {
  await withProviderScenarioResource(createCloudIosWorld, async ({ daemon, server }) => {
    const lease = await openCloudIosSession(daemon);
    server.pollsUntilFocus = Number.POSITIVE_INFINITY;

    const response = await daemon.callCommand(
      'fill',
      ['label=Email', 'user@example.com'],
      leaseFlags(lease.leaseId),
      { meta: leaseMeta(lease.leaseId) },
    );

    const error = response.json.error;
    assert.ok(error, 'expected fill to refuse');
    assert.match(error.message ?? '', /nothing there took text-entry focus/);
    assert.equal(error.data?.details?.reason, 'text_entry_focus_not_observed');
    assert.equal(server.fieldValues.email, '');
    assert.equal(textEntryTranscript(server).includes('keys'), false);
  });
}, 15_000);

/**
 * The misdelivery keyboard visibility can never catch (#1658 P1). The form is
 * already filled and focused — keyboard up — and the second fill's tap misses
 * the password field. Focus therefore never leaves `email`, so a `POST /keys`
 * here would append the password to the EMAIL field and every request would
 * still return 200. The fill must refuse before sending anything.
 */
test('cloud iOS fill sends no keys when a keyboard-up tap misses the second field', async () => {
  await withProviderScenarioResource(createCloudIosWorld, async ({ daemon, server }) => {
    const lease = await openCloudIosSession(daemon);
    server.focusField('email', 'user@example.com');
    // Focus never moves, reproducing a tap that landed outside both fields.
    server.pollsUntilFocus = Number.POSITIVE_INFINITY;

    const response = await daemon.callCommand(
      'fill',
      ['label=Password', 'hunter2'],
      leaseFlags(lease.leaseId),
      { meta: leaseMeta(lease.leaseId) },
    );

    assert.ok(response.json.error, 'expected fill to refuse');
    assert.equal(response.json.error.data?.details?.reason, 'text_entry_focus_not_observed');
    // The decisive assertion: the previous field is untouched and the password
    // never reached it.
    assert.equal(server.fieldValues.email, 'user@example.com');
    assert.equal(server.fieldValues.password, '');
    assert.equal(textEntryTranscript(server).includes('keys'), false);
  });
}, 15_000);

/** The tap/keys/keyboard requests in the order the driver received them. */
function textEntryTranscript(server: FakeIosWebDriverServer): string[] {
  const labels: Record<string, string> = {
    'POST /wd/hub/session/wd-1/actions': 'tap',
    'POST /wd/hub/session/wd-1/keys': 'keys',
    'GET /wd/hub/session/wd-1/appium/device/is_keyboard_shown': 'keyboard',
    'GET /wd/hub/session/wd-1/element/active': 'active',
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
const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
/** Two stacked inputs, as a login form has. Geometry is what decides focus. */
const FIELDS = {
  email: { x: 20, y: 300, width: 350, height: 44 },
  password: { x: 20, y: 380, width: 350, height: 44 },
} as const;
type FieldName = keyof typeof FIELDS;

class FakeIosWebDriverServer extends CloudWebDriverTestServer {
  /** How many probes after a tap before focus settles. Infinity = focus never moves. */
  pollsUntilFocus = 1;
  fieldValues: Record<FieldName, string> = { email: '', password: '' };
  focused: FieldName | undefined;

  private pollsRemaining = Number.POSITIVE_INFINITY;
  private pendingFocus: FieldName | undefined;

  static async start(): Promise<StartedCloudWebDriverTestServer<FakeIosWebDriverServer>> {
    return await startCloudWebDriverTestServer(new FakeIosWebDriverServer());
  }

  /** Puts the form in the state a completed first fill leaves it in. */
  focusField(field: FieldName, value: string): void {
    this.focused = field;
    this.fieldValues[field] = value;
    this.pollsRemaining = 0;
    this.pendingFocus = field;
  }

  protected respond(call: CloudWebDriverHttpCall) {
    const rectMatch = /^\/wd\/hub\/session\/wd-1\/element\/([^/]+)\/rect$/.exec(call.path);
    if (call.method === 'GET' && rectMatch) return this.elementRect(rectMatch[1]!);
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
      'GET /wd/hub/session/wd-1/element/active': () => this.activeElement(),
      'GET /wd/hub/session/wd-1/appium/device/is_keyboard_shown': () =>
        cloudWebDriverTestJson({ value: this.keyboardShown() }),
    };
  }

  /**
   * A tap moves focus only if it actually lands inside a field. A miss leaves
   * the previous field focused — which is exactly how keys can reach the wrong
   * one while every request still succeeds.
   */
  private tap(): CloudWebDriverTestResponse {
    const point = this.lastTapPoint();
    const hit =
      point && (Object.keys(FIELDS) as FieldName[]).find((n) => contains(FIELDS[n], point));
    this.pendingFocus = hit ?? this.focused;
    this.pollsRemaining = hit ? this.pollsUntilFocus : Number.POSITIVE_INFINITY;
    if (hit) this.focused = undefined;
    return cloudWebDriverTestJson({ value: null });
  }

  /** Focus is not instant: it settles only after the configured number of probes. */
  private settle(): void {
    if (this.pollsRemaining <= 0) return;
    this.pollsRemaining -= 1;
    if (this.pollsRemaining <= 0) this.focused = this.pendingFocus;
  }

  private activeElement(): CloudWebDriverTestResponse {
    this.settle();
    if (!this.focused) {
      return cloudWebDriverTestJson(
        { value: { error: 'no such element', message: 'nothing is focused' } },
        404,
      );
    }
    return cloudWebDriverTestJson({ value: { [W3C_ELEMENT_KEY]: this.focused } });
  }

  private elementRect(elementId: string): CloudWebDriverTestResponse {
    const rect = FIELDS[elementId as FieldName];
    if (!rect) {
      return cloudWebDriverTestJson(
        { value: { error: 'no such element', message: `unknown element ${elementId}` } },
        404,
      );
    }
    return cloudWebDriverTestJson({ value: rect });
  }

  private keyboardShown(): boolean {
    this.settle();
    return this.focused !== undefined;
  }

  private sendKeys(): CloudWebDriverTestResponse {
    // Unfocused keys are accepted by the grid and land nowhere; keys sent while
    // the WRONG field holds focus land in that field. Both are the bug's shape.
    const text = this.lastSentKeys();
    if (this.focused && text !== undefined) this.fieldValues[this.focused] = text;
    return cloudWebDriverTestJson({ value: null });
  }

  private lastTapPoint(): { x: number; y: number } | undefined {
    const body = this.calls.at(-1)?.body as { actions?: unknown } | undefined;
    const sequences = Array.isArray(body?.actions) ? body.actions : [];
    for (const sequence of sequences) {
      const actions = (sequence as { actions?: unknown }).actions;
      if (!Array.isArray(actions)) continue;
      const move = actions.find((a) => (a as { type?: string }).type === 'pointerMove') as
        | { x?: unknown; y?: unknown }
        | undefined;
      if (typeof move?.x === 'number' && typeof move.y === 'number') {
        return { x: move.x, y: move.y };
      }
    }
    return undefined;
  }

  private lastSentKeys(): string | undefined {
    const body = this.calls.at(-1)?.body as { value?: unknown } | undefined;
    return Array.isArray(body?.value) ? body.value.join('') : undefined;
  }

  private source(): string {
    const field = (name: FieldName, label: string) =>
      `<XCUIElementTypeTextField name="${name}" label="${label}" value="${this.fieldValues[name]}" ` +
      `x="${FIELDS[name].x}" y="${FIELDS[name].y}" width="${FIELDS[name].width}" ` +
      `height="${FIELDS[name].height}" visible="true" enabled="true" />`;
    return (
      '<XCUIElementTypeApplication name="Demo" x="0" y="0" width="390" height="844" visible="true">' +
      field('email', 'Email') +
      field('password', 'Password') +
      '</XCUIElementTypeApplication>'
    );
  }
}

function contains(
  rect: { x: number; y: number; width: number; height: number },
  p: { x: number; y: number },
): boolean {
  return (
    p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height
  );
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
