import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../emulator-console.ts', () => ({ runEmulatorConsole: vi.fn() }));
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(async () => undefined),
}));

import { sleep } from '@agent-device/host-kit/retry';
import { runEmulatorConsole } from '../emulator-console.ts';
import { ANDROID_EMULATOR } from '../runtime.fixtures.ts';
import { shakeAndroidEmulator } from './console-shake.ts';

const mockConsole = vi.mocked(runEmulatorConsole);
const REST = 'acceleration = 0:9.776:0.812\nOK\n';

function consoleCommands(): string[] {
  return mockConsole.mock.calls.map(([, command]) => command.join(' '));
}

beforeEach(() => {
  mockConsole.mockReset();
  vi.mocked(sleep).mockClear();
});

test('swings the accelerometer in alternating directions, then restores the reading it found', async () => {
  mockConsole.mockImplementation(async (_device, command) => ({
    stdout: command[1] === 'get' ? REST : 'OK\n',
  }));
  const { signal } = new AbortController();

  await shakeAndroidEmulator(ANDROID_EMULATOR, signal);

  const commands = consoleCommands();
  expect(commands[0]).toBe('sensor get acceleration');
  const swings = commands.slice(1, -1);
  expect(swings).toHaveLength(10);
  swings.forEach((command, index) => {
    expect(command).toBe(`sensor set acceleration ${index % 2 === 0 ? '20' : '-20'}:9.776:0.812`);
  });
  expect(commands.at(-1)).toBe('sensor set acceleration 0:9.776:0.812');
  expect(sleep).toHaveBeenCalledTimes(10);
  expect(sleep).toHaveBeenCalledWith(80, signal);
});

test('a console refusal mid-shake still restores the rest reading and fails typed', async () => {
  let sets = 0;
  mockConsole.mockImplementation(async (_device, command) => {
    if (command[1] === 'get') return { stdout: REST };
    sets += 1;
    return sets === 2
      ? { stdout: 'KO: sensor disabled\n', refusal: 'sensor disabled' }
      : { stdout: 'OK\n' };
  });

  await expect(shakeAndroidEmulator(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'shake-console-refused', consoleReason: 'sensor disabled' },
  });
  expect(consoleCommands().at(-1)).toBe('sensor set acceleration 0:9.776:0.812');
});

test('an unreadable rest reading fails before any swing is sent', async () => {
  mockConsole.mockResolvedValue({ stdout: 'OK\n' });

  await expect(shakeAndroidEmulator(ANDROID_EMULATOR, undefined)).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'shake-rest-acceleration-unreadable', dispatched: 'no' },
  });
  expect(consoleCommands()).toEqual(['sensor get acceleration']);
});

test('a cancelled shake stops swinging and restores the rest reading without the signal', async () => {
  const controller = new AbortController();
  mockConsole.mockImplementation(async (_device, command) => {
    if (command[1] === 'set' && command[3]!.startsWith('20')) controller.abort();
    return { stdout: command[1] === 'get' ? REST : 'OK\n' };
  });

  await expect(shakeAndroidEmulator(ANDROID_EMULATOR, controller.signal)).rejects.toThrow();
  expect(consoleCommands()).toEqual([
    'sensor get acceleration',
    'sensor set acceleration 20:9.776:0.812',
    'sensor set acceleration 0:9.776:0.812',
  ]);
  expect(mockConsole.mock.calls.at(-1)![2]).toBeUndefined();
});
