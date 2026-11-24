import fs from 'node:fs';
import { beforeEach, expect, test, vi } from 'vitest';
import { bindTestCommandHost, createLiveTestHostEnvironment } from '@agent-device/test-kit';

vi.mock('./fold-helper-cache.ts', () => ({
  ensureFoldHelperBinary: vi.fn(async () => ({ path: '/cache/fold-helper' })),
}));
vi.mock('../core/runner-client.ts', () => ({
  runAppleRunnerCommand: vi.fn(async () => ({})),
}));

import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import { runAppleRunnerCommand } from '../core/runner-client.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../core/tool-provider.ts';
import { createAppleInteractor } from '../interactor.ts';
import { IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';
import { IPHONE_17_SINGLE_PANEL, IPHONE_DUO_CLOSED } from '../__tests__/display-fixtures.ts';

bindTestCommandHost();

const mockRunner = vi.mocked(runAppleRunnerCommand);

beforeEach(() => {
  mockRunner.mockClear();
});

/** A fresh simulator id per test: the daemon keeps each simulator's resolved panel count. */
let simulatorCount = 0;
function simulator(): DeviceInfo {
  simulatorCount += 1;
  return { ...IOS_SIMULATOR, id: `${IOS_SIMULATOR.id}-home-${simulatorCount}` };
}

/** Runs `use` on an interactor whose simulator reports `panels`, and records the helper modes. */
async function run(panels: object, use: (interactor: Interactor) => Promise<unknown>) {
  const device = simulator();
  const helpers: string[][] = [];
  const provider = createLocalAppleToolProvider({
    runCommand: async (_command, args) => {
      if (args.slice(0, 4).join(' ') === 'devicectl device info displays') {
        fs.writeFileSync(args.at(-1)!, JSON.stringify(panels));
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      const spawn = args.slice(args.indexOf('spawn'));
      expect(spawn.slice(0, 3)).toEqual(['spawn', device.id, '/cache/fold-helper']);
      helpers.push(spawn.slice(3));
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  await withAppleToolProvider(provider, () =>
    use(createAppleInteractor(device, {}, createLiveTestHostEnvironment())),
  );
  return helpers;
}

test.each([
  ['home', (i: Interactor) => i.home!(), ['home', '1']],
  ['appSwitcher', (i: Interactor) => i.appSwitcher!(), ['home', '2']],
] as const)('%s on a foldable simulator presses Home through HID', async (_name, use, mode) => {
  await expect(run(IPHONE_DUO_CLOSED, use)).resolves.toEqual([mode]);
  expect(mockRunner).not.toHaveBeenCalled();
});

test.each([
  ['home', (i: Interactor) => i.home!()],
  ['appSwitcher', (i: Interactor) => i.appSwitcher!()],
] as const)('%s on a single-panel simulator keeps the runner press', async (command, use) => {
  await expect(run(IPHONE_17_SINGLE_PANEL, use)).resolves.toEqual([]);
  expect(mockRunner).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ command }),
    expect.anything(),
  );
});
