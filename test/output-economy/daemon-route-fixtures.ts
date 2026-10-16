import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from '@agent-device/capture-kit/png';
import type { BackendDumpNetworkResult } from '@agent-device/contracts/backend-diagnostics';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { WebProvider } from '@agent-device/platform-web';
import { WEB_DESKTOP_DEVICE } from '@agent-device/test-kit';
import { createProviderScenarioHarness } from '../integration/provider-scenarios/harness.ts';
import { NETWORK_SELECTION_RESULT } from './selection-fixtures.ts';

const SCREENSHOT_PATH = path.join(os.tmpdir(), `agent-device-output-economy-${process.pid}.png`);
const STABLE_SCREENSHOT_PATH = '/tmp/agent-device/economy-fixture.png';

const beforeOrder: RawSnapshotNode[] = [
  {
    index: 0,
    ref: 'e1',
    type: 'Window',
    role: 'window',
    label: 'Checkout',
    depth: 0,
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    index: 1,
    ref: 'e2',
    type: 'TextField',
    role: 'text-field',
    label: 'Email',
    value: 'qa@example.com',
    identifier: 'checkout-email',
    hittable: true,
    enabled: true,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 120, width: 350, height: 44 },
  },
  {
    index: 2,
    ref: 'e3',
    type: 'Button',
    role: 'button',
    label: 'Place order',
    identifier: 'submit-order',
    hittable: true,
    enabled: true,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 720, width: 350, height: 48 },
  },
  {
    index: 3,
    type: 'StaticText',
    role: 'text',
    label: 'Shipping address',
    hittable: false,
    enabled: false,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 420, width: 350, height: 24 },
  },
  {
    index: 4,
    type: 'StaticText',
    role: 'text',
    label: 'Payment method',
    hittable: false,
    enabled: false,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 480, width: 350, height: 24 },
  },
  {
    index: 5,
    type: 'StaticText',
    role: 'text',
    label: 'Order total',
    hittable: false,
    enabled: false,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 540, width: 350, height: 24 },
  },
];

const afterOrder: RawSnapshotNode[] = [
  beforeOrder[0]!,
  beforeOrder[1]!,
  {
    index: 2,
    ref: 'e4',
    type: 'StaticText',
    role: 'text',
    label: 'Order confirmed',
    hittable: false,
    enabled: false,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 660, width: 350, height: 32 },
  },
  {
    index: 3,
    ref: 'e5',
    type: 'Button',
    role: 'button',
    label: 'View receipt',
    hittable: true,
    enabled: true,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 720, width: 350, height: 48 },
  },
  {
    index: 4,
    type: 'StaticText',
    role: 'text',
    label: 'Shipping address',
    hittable: false,
    enabled: false,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 420, width: 350, height: 24 },
  },
  {
    index: 5,
    type: 'StaticText',
    role: 'text',
    label: 'Payment method',
    hittable: false,
    enabled: false,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 480, width: 350, height: 24 },
  },
  {
    index: 6,
    type: 'StaticText',
    role: 'text',
    label: 'Order total',
    hittable: false,
    enabled: false,
    depth: 1,
    parentIndex: 0,
    rect: { x: 20, y: 540, width: 350, height: 24 },
  },
];

function makePng(): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function stableResponseData(response: { json: any }, operation: string): Record<string, any> {
  const error = response.json?.error;
  if (error) throw new Error(`${operation} failed: ${JSON.stringify(error)}`);
  const data = response.json?.result?.data;
  if (!data || typeof data !== 'object') {
    throw new Error(`${operation} returned no response data`);
  }
  return stabilizeVolatileFields(data) as Record<string, any>;
}

function stabilizeVolatileFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stabilizeVolatileFields);
  if (typeof value === 'string') return value.replaceAll(SCREENSHOT_PATH, STABLE_SCREENSHOT_PATH);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      key === 'artifactId' && typeof entry === 'string'
        ? 'artifact-economy-fixture'
        : record.artifactType === 'screenshot' && key === 'fileName' && typeof entry === 'string'
          ? 'economy-fixture.png'
          : ['maxMs', 'p50Ms', 'p95Ms', 'waitedMs'].includes(key) && typeof entry === 'number'
            ? 100
            : stabilizeVolatileFields(entry),
    ]),
  );
}

export async function captureOutputEconomyDaemonResponses() {
  let page: 'before-order' | 'after-order' | 'receipt-open' = 'before-order';
  const routeTrace: string[] = [];
  const png = makePng();
  const networkEntries =
    NETWORK_SELECTION_RESULT.entries as unknown as BackendDumpNetworkResult['entries'];
  const webProvider: WebProvider = {
    async open() {},
    async close() {},
    async snapshot() {
      routeTrace.push(`snapshot:${page}`);
      const nodes = page === 'before-order' ? beforeOrder : afterOrder;
      return {
        nodes:
          page === 'receipt-open'
            ? nodes.filter((node) => node.ref !== 'e5' && node.ref !== 'e4')
            : nodes,
        truncated: false,
      };
    },
    async screenshot(outPath) {
      fs.writeFileSync(outPath, png);
    },
    async setViewport() {},
    async click(x, y) {
      routeTrace.push(`click:${x}:${y}`);
      if (y >= 700 && page === 'before-order') page = 'after-order';
      else if (y >= 700 && page === 'after-order') page = 'receipt-open';
    },
    async fill() {},
    async typeText() {},
    async scroll() {},
    async dumpNetwork() {
      return {
        entries: networkEntries,
        backend: 'agent-browser',
        redacted: false,
        notes: NETWORK_SELECTION_RESULT.notes as string[],
      };
    },
  };
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [WEB_DESKTOP_DEVICE],
    webProvider: () => webProvider,
  });

  try {
    const open = async (session: string) => {
      page = 'before-order';
      stableResponseData(
        await daemon.callCommand(
          'open',
          ['https://example.test/checkout'],
          { platform: 'web' },
          { session },
        ),
        `open ${session}`,
      );
    };
    const close = async (session: string) => {
      stableResponseData(
        await daemon.callCommand('close', [], {}, { session }),
        `close ${session}`,
      );
    };
    const clickAndSettle = async (
      session: string,
      responseLevel?: 'digest',
    ): Promise<Record<string, any>> => {
      const response = await daemon.callCommand(
        'click',
        ['195', '744'],
        { platform: 'web', settle: true, settleQuietMs: 25, timeoutMs: 10_000 },
        {
          session,
          ...(responseLevel ? { meta: { responseLevel } } : {}),
        },
      );
      if (response.json?.error) {
        throw new Error(
          `click ${responseLevel ?? 'default'} failed: ${JSON.stringify(response.json.error)}; ${routeTrace.join(', ')}`,
        );
      }
      const data = stableResponseData(response, `click ${responseLevel ?? 'default'}`);
      if ((data.settle as { settled?: unknown } | undefined)?.settled !== true) {
        throw new Error(
          `click ${responseLevel ?? 'default'} did not settle: ${JSON.stringify(data.settle)}; ${routeTrace.join(', ')}`,
        );
      }
      return data;
    };

    await open('default');

    const snapshotDefault = stableResponseData(
      await daemon.callCommand('snapshot', [], { platform: 'web' }),
      'snapshot default',
    );
    const snapshotDigest = stableResponseData(
      await daemon.callCommand(
        'snapshot',
        [],
        { platform: 'web' },
        { meta: { responseLevel: 'digest' } },
      ),
      'snapshot digest',
    );
    const selectorDefault = stableResponseData(
      await daemon.callCommand('get', ['text', '@e2'], { platform: 'web' }),
      'selector read default',
    );
    const selectorDigest = stableResponseData(
      await daemon.callCommand(
        'get',
        ['text', '@e2'],
        { platform: 'web' },
        { meta: { responseLevel: 'digest' } },
      ),
      'selector read digest',
    );

    const settleDefault = await clickAndSettle('default');
    stableResponseData(
      await daemon.callCommand('snapshot', [], { platform: 'web' }, { session: 'default' }),
      'post-order snapshot',
    );
    const settleTailDefault = await clickAndSettle('default');
    await close('default');

    await open('digest');
    stableResponseData(
      await daemon.callCommand('snapshot', [], { platform: 'web' }, { session: 'digest' }),
      'digest session snapshot',
    );
    const screenshotDefault = stableResponseData(
      await daemon.callCommand(
        'screenshot',
        [SCREENSHOT_PATH],
        { platform: 'web', overlayRefs: true },
        { session: 'digest', meta: { clientArtifactPaths: { path: SCREENSHOT_PATH } } },
      ),
      'screenshot default',
    );
    const screenshotDigest = stableResponseData(
      await daemon.callCommand(
        'screenshot',
        [SCREENSHOT_PATH],
        { platform: 'web', overlayRefs: true },
        {
          session: 'digest',
          meta: {
            responseLevel: 'digest',
            clientArtifactPaths: { path: SCREENSHOT_PATH },
          },
        },
      ),
      'screenshot digest',
    );
    stableResponseData(
      await daemon.callCommand('snapshot', [], { platform: 'web' }, { session: 'digest' }),
      'digest pre-click snapshot',
    );
    const settleDigest = await clickAndSettle('digest', 'digest');
    stableResponseData(
      await daemon.callCommand('snapshot', [], { platform: 'web' }, { session: 'digest' }),
      'digest post-order snapshot',
    );
    const settleTailDigest = await clickAndSettle('digest', 'digest');

    const networkDefault = stableResponseData(
      await daemon.callCommand(
        'network',
        ['dump', '25', 'all'],
        { platform: 'web' },
        { session: 'digest' },
      ),
      'network default',
    );
    const networkDigest = stableResponseData(
      await daemon.callCommand(
        'network',
        ['dump', '25', 'all'],
        { platform: 'web' },
        { session: 'digest', meta: { responseLevel: 'digest' } },
      ),
      'network digest',
    );

    return {
      snapshotDefault,
      snapshotDigest,
      selectorDefault,
      selectorDigest,
      settleDefault,
      settleDigest,
      settleTailDefault,
      settleTailDigest,
      screenshotDefault,
      screenshotDigest,
      networkDefault,
      networkDigest,
    };
  } finally {
    await daemon.close();
    fs.rmSync(SCREENSHOT_PATH, { force: true });
  }
}
