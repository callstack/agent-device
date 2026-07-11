import type { DebugSymbolsResult } from '../../src/contracts/debug-symbols.ts';
import type { DaemonResponseData } from '../../src/daemon/types.ts';

const requestBody = JSON.stringify({
  cartId: 'cart-economy-fixture',
  items: Array.from({ length: 12 }, (_, index) => ({
    sku: `sku-${index + 1}`,
    quantity: index + 1,
  })),
});

const responseBody = JSON.stringify({
  orderId: 'order-economy-fixture',
  status: 'confirmed',
  receipt: 'receipt-line '.repeat(80),
});

export const NETWORK_SELECTION_RESULT: DaemonResponseData = {
  path: '/tmp/agent-device/economy-fixture/app.log',
  exists: true,
  active: true,
  state: 'active',
  backend: 'ios-simulator',
  include: 'all',
  scannedLines: 4000,
  matchedLines: 8,
  limits: { maxEntries: 25, maxPayloadChars: 2048, maxScanLines: 4000 },
  entries: Array.from({ length: 8 }, (_, index) => ({
    timestamp: `2026-07-02T12:00:${String(index).padStart(2, '0')}.000Z`,
    method: index === 0 ? 'POST' : 'GET',
    url: `https://api.example.test/checkout/${index + 1}`,
    status: index === 0 ? 503 : 200,
    durationMs: 120 + index * 17,
    packetId: `packet-${index + 1}`,
    line: 3900 + index,
    headers: `authorization: <redacted>\ncontent-type: application/json\nx-request-id: request-${index + 1}`,
    requestHeaders: {
      authorization: '<redacted>',
      'content-type': 'application/json',
      'x-request-id': `request-${index + 1}`,
    },
    responseHeaders: {
      'content-type': 'application/json',
      'x-request-id': `request-${index + 1}`,
      'x-retry-after-ms': index === 0 ? '500' : '0',
    },
    requestBody,
    responseBody,
    raw: `network capture ${index + 1}: ${responseBody}`,
  })),
  notes: ['The first checkout request returned 503. Retry after the service recovery window.'],
};

export const EVENTS_SELECTION_RESULT: DaemonResponseData = {
  path: '/tmp/agent-device/economy-fixture/events.ndjson',
  cursor: '0',
  nextCursor: '18',
  limit: 18,
  events: Array.from({ length: 18 }, (_, index) => ({
    version: 1,
    ts: `2026-07-02T12:00:${String(index).padStart(2, '0')}.000Z`,
    session: 'economy-fixture',
    kind: index % 3 === 0 ? 'action.recorded' : 'request.finished',
    requestId: `request-${index + 1}`,
    command: index % 3 === 0 ? 'press' : 'snapshot',
    status: index % 3 === 0 ? undefined : 'ok',
    summary: index % 3 === 0 ? `Tapped @e${index + 2}` : 'Finished snapshot',
    details: {
      durationMs: 120 + index,
      publicSession: 'economy-fixture',
      effectiveSession: 'economy-fixture',
      requestLogPath: `/tmp/agent-device/economy-fixture/requests/request-${index + 1}.log`,
      runnerLogPath: '/tmp/agent-device/economy-fixture/runner.log',
    },
  })),
};

export const DEBUG_SELECTION_RESULT: DebugSymbolsResult = {
  kind: 'debugSymbols',
  platform: 'apple',
  artifactPath: '/tmp/agent-device/economy-fixture/Checkout.ips',
  outPath: '/tmp/agent-device/economy-fixture/Checkout.symbolicated.ips',
  crash: {
    format: 'ips',
    appName: 'Checkout',
    bundleId: 'com.example.checkout',
    version: '1.0.0',
    incident: 'incident-economy-fixture',
    timestamp: '2026-07-02T12:00:00.000Z',
    exceptionType: 'EXC_BAD_ACCESS',
    exceptionCodes: 'KERN_INVALID_ADDRESS',
    terminationReason: 'Namespace SIGNAL, Code 11 Segmentation fault: 11',
    crashedThread: 0,
    topFrames: Array.from({ length: 20 }, (_, index) => ({
      index,
      image: index % 2 === 0 ? 'Checkout' : 'libswiftCore.dylib',
      address: `0x${(4096 + index * 32).toString(16)}`,
      symbol: `CheckoutFlow.processStep${index}(cart:completion:) + ${index * 4}`,
    })),
    findings: [
      'The crashed thread dereferenced an invalid address in CheckoutFlow.',
      'The first application frame is symbolicated and should be investigated first.',
    ],
  },
  matchedImages: Array.from({ length: 8 }, (_, index) => ({
    name: index === 0 ? 'Checkout' : `Framework${index}`,
    uuid: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    arch: 'arm64',
    dsymPath: `/tmp/dsyms/Framework${index}.framework.dSYM`,
    binaryPath: `/tmp/app/Frameworks/Framework${index}.framework/Framework${index}`,
  })),
  symbolicatedFrames: 20,
  skippedImages: 0,
  warnings: ['One system image had no matching dSYM; application frames were symbolicated.'],
  message: 'Wrote symbolicated crash report.',
};

export const RECORDING_SELECTION_RESULT: DaemonResponseData = {
  recording: 'stopped',
  outPath: '/tmp/agent-device/economy-fixture/recording.mp4',
  telemetryPath: '/tmp/agent-device/economy-fixture/recording.gesture-telemetry.json',
  recordingBackend: 'adb-screenrecord',
  recordingScope: 'app',
  durationMs: 1_920_000,
  showTouches: true,
  warning: 'Android screenrecord split the long capture into bounded chunks.',
  overlayWarning: 'Touch overlay burn-in was skipped; gesture telemetry remains available.',
  chunks: Array.from({ length: 12 }, (_, index) => ({
    index: index + 1,
    path:
      index === 0
        ? '/tmp/agent-device/economy-fixture/recording.mp4'
        : `/tmp/agent-device/economy-fixture/recording.part-${String(index + 1).padStart(3, '0')}.mp4`,
  })),
  artifacts: Array.from({ length: 13 }, (_, index) => ({
    field: index === 12 ? 'telemetryPath' : 'outPath',
    artifactType: index === 12 ? 'screen-recording-telemetry' : 'screen-recording-chunk',
    artifactId: `artifact-recording-${index + 1}`,
    fileName:
      index === 12
        ? 'recording.gesture-telemetry.json'
        : `recording.part-${String(index + 1).padStart(3, '0')}.mp4`,
  })),
};
