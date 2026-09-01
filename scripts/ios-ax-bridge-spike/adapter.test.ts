import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { defaultPublicMacOsAxHelperPath, readControlSnapshot } from './adapter.ts';

test('public AX adapter resolves the SwiftPM release product', () => {
  assert.equal(
    defaultPublicMacOsAxHelperPath('/repo'),
    '/repo/scripts/ios-ax-bridge-spike/swift/.build/release/agent-device-ios-ax-bridge-spike',
  );
});

test('spike executable stays outside the distributed macOS helper package', () => {
  const manifest = fs.readFileSync(
    new URL('../../apple/macos-helper/Package.swift', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(manifest, /AgentDeviceIosAxBridgeSpike|agent-device-ios-ax-bridge-spike/);
});

test('control mapping preserves the producer raw node type', () => {
  const result = readControlSnapshot({
    data: {
      results: [
        {
          data: {
            snapshot: {
              nodes: [
                {
                  index: 7,
                  type: 'XCUIElementTypeButton',
                  role: 'AXButton',
                },
              ],
            },
          },
        },
      ],
    },
  });

  assert.equal(result?.nodes[0]?.type, 'XCUIElementTypeButton');
  assert.equal(result?.nodes[0]?.role, 'AXButton');
});
