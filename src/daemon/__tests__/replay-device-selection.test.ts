import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReplayTargetDeviceResolutionOptions } from '../replay-device-selection.ts';

test('replay leaves deep-link opens to normal device resolution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-device-selection-'));
  const replayPath = path.join(root, 'deep-link.ad');
  fs.writeFileSync(replayPath, 'open demo://checkout\n');

  expect(
    buildReplayTargetDeviceResolutionOptions({
      token: 'test-token',
      session: 'default',
      command: 'replay',
      positionals: [replayPath],
      meta: { cwd: root },
    }),
  ).toBeUndefined();
});
