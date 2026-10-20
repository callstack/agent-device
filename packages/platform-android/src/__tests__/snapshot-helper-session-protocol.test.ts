import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  isAndroidSnapshotHelperSessionCommandAcknowledged,
  parseAndroidSnapshotHelperSessionTouchResponse,
  parseAndroidSnapshotHelperSessionSnapshotResponse,
} from '../snapshot-helper-session-protocol.ts';

test('parses the session envelope and snapshot metadata', () => {
  const xml = '<hierarchy><node text="catalog" /></hierarchy>';
  const response = sessionResponse({
    requestId: 'snapshot-1',
    xml,
    metadata: {
      captureMode: 'interactive-windows',
      windowCount: '2',
      missingRootWindowTypes: '2',
      nodeCount: '1',
      pixelDensity: '2.625',
    },
  });

  assert.deepEqual(parseAndroidSnapshotHelperSessionSnapshotResponse(response, 'snapshot-1'), {
    xml,
    metadata: {
      helperApiVersion: '1',
      outputFormat: 'uiautomator-xml',
      captureMode: 'interactive-windows',
      windowCount: 2,
      missingRootWindowTypes: [2],
      nodeCount: 1,
      pixelDensity: 2.625,
      waitForIdleTimeoutMs: undefined,
      waitForIdleQuietMs: undefined,
      timeoutMs: undefined,
      maxDepth: undefined,
      maxNodes: undefined,
      rootPresent: undefined,
      cacheInvalidated: undefined,
      truncated: undefined,
      elapsedMs: undefined,
      displayWidth: undefined,
      displayHeight: undefined,
    },
  });
});

// The session transport reads the display pair exactly like the one-shot transport does (#3182),
// and a header that never arrived stays an absence rather than becoming a zero.
test('parses the session display extent beside its density and absent headers stay absent (#3182)', () => {
  const xml = '<hierarchy><node text="catalog" /></hierarchy>';
  const withDisplay = sessionResponse({
    requestId: 'snapshot-1',
    xml,
    metadata: { pixelDensity: '2.625', displayWidth: '1080', displayHeight: '2400' },
  });

  const parsed = parseAndroidSnapshotHelperSessionSnapshotResponse(withDisplay, 'snapshot-1');

  assert.equal(parsed.metadata.pixelDensity, 2.625);
  assert.equal(parsed.metadata.displayWidth, 1080);
  assert.equal(parsed.metadata.displayHeight, 2400);

  const withoutDisplay = sessionResponse({
    requestId: 'snapshot-1',
    xml,
    metadata: { pixelDensity: '2.625' },
  });
  const sparse = parseAndroidSnapshotHelperSessionSnapshotResponse(withoutDisplay, 'snapshot-1');
  assert.equal(sparse.metadata.displayWidth, undefined);
  assert.equal(sparse.metadata.displayHeight, undefined);
});

test('reads the session window types the helper could not serialize, absent from an older helper', () => {
  const xml = '<hierarchy><node text="catalog" /></hierarchy>';
  const read = (metadata: Record<string, string>) =>
    parseAndroidSnapshotHelperSessionSnapshotResponse(
      sessionResponse({ requestId: 'snapshot-1', xml, metadata }),
      'snapshot-1',
    ).metadata.missingRootWindowTypes;

  assert.deepEqual(read({ missingRootWindowTypes: '1,2' }), [1, 2]);
  assert.deepEqual(read({ missingRootWindowTypes: '' }), []);
  assert.equal(read({ missingRootWindowTypes: '1,x' }), undefined);
  // Number() would read these as 0 or 2; only plain decimal digits count.
  assert.equal(read({ missingRootWindowTypes: '1,,2' }), undefined);
  assert.equal(read({ missingRootWindowTypes: '0x2' }), undefined);
  assert.equal(read({ missingRootWindowTypes: ' 2' }), undefined);
  assert.equal(read({ missingRootWindowTypes: '-2' }), undefined);
  assert.equal(read({}), undefined);
});

test('rejects stale and truncated session snapshot responses', () => {
  const response = sessionResponse({
    requestId: 'snapshot-old',
    xml: '<hierarchy></hierarchy>',
  });
  assert.throws(
    () => parseAndroidSnapshotHelperSessionSnapshotResponse(response, 'snapshot-new'),
    /stale output/,
  );
  assert.throws(
    () =>
      parseAndroidSnapshotHelperSessionSnapshotResponse(
        response.replace('byteLength=23', 'byteLength=99'),
        'snapshot-old',
      ),
    /truncated XML/,
  );
});

test('validates touch and quit response identity from the same protocol headers', () => {
  const response = sessionResponse({ requestId: 'gesture-1', xml: '' });
  parseAndroidSnapshotHelperSessionTouchResponse(response, 'gesture-1');

  assert.equal(isAndroidSnapshotHelperSessionCommandAcknowledged(response, 'gesture-1'), true);
  assert.throws(
    () => parseAndroidSnapshotHelperSessionTouchResponse(response, 'gesture-stale'),
    /stale output/,
  );
});

function sessionResponse(params: {
  requestId: string;
  xml: string;
  metadata?: Record<string, string>;
}): string {
  const headers = {
    agentDeviceProtocol: 'android-snapshot-helper-v1',
    helperApiVersion: '1',
    outputFormat: 'uiautomator-xml',
    requestId: params.requestId,
    ok: 'true',
    byteLength: String(Buffer.byteLength(params.xml, 'utf8')),
    ...params.metadata,
  };
  return `${Object.entries(headers)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n\n${params.xml}`;
}

test('helper timeout diagnostics omit encoded text input', async () => {
  const net = await import('node:net');
  const { sendAndroidSnapshotHelperSessionCommand } =
    await import('../snapshot-helper-session-protocol.ts');
  const sockets = new Set<import('node:net').Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const encoded = Buffer.from(JSON.stringify({ text: 'private fill value' })).toString('base64');
  try {
    await assert.rejects(
      sendAndroidSnapshotHelperSessionCommand(address.port, `input request-1 ${encoded}`, 20),
      (error) => {
        assert(error instanceof AppError);
        assert(!JSON.stringify(error).includes(encoded));
        assert.equal(error.details?.command, 'input');
        return true;
      },
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
