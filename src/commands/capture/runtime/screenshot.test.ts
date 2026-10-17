import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from '@agent-device/capture-kit/png';
import type { AgentDeviceBackend } from '@agent-device/contracts/backend';
import { localCommandPolicy } from '@agent-device/contracts/command-policy';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { test } from 'vitest';
import { createLocalArtifactAdapter } from '../../../io.ts';
import { createAgentDevice } from '../../../runtime.ts';

test('runtime screenshot applies scale and forwards the capture rotation', async () => {
  const outPath = path.join(mkdtempForTestSync('runtime-screenshot-command-'), 'scaled.png');
  const device = createAgentDevice({
    backend: {
      platform: 'ios',
      captureScreenshot: async (_context, requestedPath) => {
        fs.writeFileSync(requestedPath, solidPngBuffer(100, 50));
        return { displayRotation: 'landscape-left' };
      },
    } satisfies AgentDeviceBackend,
    artifacts: createLocalArtifactAdapter(),
    sessions: { get: () => undefined, set: () => {} },
    policy: localCommandPolicy(),
  });

  const result = await device.capture.screenshot({
    out: { kind: 'path', path: outPath },
    scale: 0.5,
  });
  const scaled = PNG.sync.read(fs.readFileSync(outPath));

  assert.deepEqual({ width: scaled.width, height: scaled.height }, { width: 50, height: 25 });
  assert.equal(result.displayRotation, 'landscape-left');
});

function solidPngBuffer(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255;
  return PNG.sync.write(png);
}
