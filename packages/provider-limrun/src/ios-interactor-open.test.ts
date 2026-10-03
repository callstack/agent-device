import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';

function sessionWithClient(result = { code: 0, stdout: '', stderr: '' }) {
  const wait = async () => result;
  const client = {
    launchApp: vi.fn(async () => {}),
    openUrl: vi.fn(async () => {}),
    simctl: vi.fn((_argv: string[]) => ({ wait })),
  };
  const session = {
    platform: 'ios',
    instanceId: 'limrun-open-instance',
    client,
    dependencies: { ios: { resolveAppAlias: async (app: string) => app } },
  } as unknown as LimrunIosSession;
  return { interactor: createLimrunIosInteractor(session), client };
}

test('launch arguments relaunch the app through simctl instead of launchApp', async () => {
  const { interactor, client } = sessionWithClient();

  await interactor.open('com.example.app', { launchArgs: ['--flag', 'value'] });

  expect(client.simctl).toHaveBeenCalledTimes(1);
  expect(client.simctl.mock.calls[0]?.[0]).toEqual([
    'launch',
    '--terminate-running-process',
    'booted',
    'com.example.app',
    '--flag',
    'value',
  ]);
  expect(client.launchApp).not.toHaveBeenCalled();
});

test('without launch arguments the app launches through launchApp only', async () => {
  const { interactor, client } = sessionWithClient();

  await interactor.open('com.example.app');

  expect(client.launchApp).toHaveBeenCalledTimes(1);
  expect(client.launchApp).toHaveBeenCalledWith('com.example.app');
  expect(client.simctl).not.toHaveBeenCalled();
});

test('a url open launches with the arguments, then opens the url', async () => {
  const { interactor, client } = sessionWithClient();
  const order: string[] = [];
  client.simctl.mockImplementation(() => {
    order.push('simctl');
    return { wait: async () => ({ code: 0, stdout: '', stderr: '' }) };
  });
  client.openUrl.mockImplementation(async () => {
    order.push('openUrl');
  });

  await interactor.open('com.example.app', {
    url: 'myapp://home',
    launchArgs: ['--flag', 'value'],
  });

  expect(order).toEqual(['simctl', 'openUrl']);
  expect(client.openUrl).toHaveBeenCalledWith('myapp://home');
  expect(client.launchApp).not.toHaveBeenCalled();
});

test('a failing simctl launch rejects with typed exit code and stderr', async () => {
  const { interactor, client } = sessionWithClient({
    code: 1,
    stdout: '',
    stderr: 'launch failed\n',
  });

  const rejection = expect(interactor.open('com.example.app', { launchArgs: ['--flag'] })).rejects;
  await rejection.toBeInstanceOf(AppError);
  await rejection.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { exitCode: 1, stderr: 'launch failed' },
  });
  expect(client.openUrl).not.toHaveBeenCalled();
});
