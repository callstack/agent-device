import { expect, test, vi } from 'vitest';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';

function sessionWithClient() {
  const client = {
    pressKey: vi.fn(async () => {}),
    performActions: vi.fn(async () => ({ results: [] })),
  };
  const session = {
    platform: 'ios',
    instanceId: 'limrun-home-instance',
    client,
  } as unknown as LimrunIosSession;
  return { interactor: createLimrunIosInteractor(session), client };
}

test('home presses and releases the hardware home button in one batch', async () => {
  const { interactor, client } = sessionWithClient();

  await interactor.home!();

  expect(client.performActions).toHaveBeenCalledTimes(1);
  expect(client.performActions).toHaveBeenCalledWith([
    { type: 'buttonDown', button: 'home' },
    { type: 'buttonUp', button: 'home' },
  ]);
  expect(client.pressKey).not.toHaveBeenCalled();
});

test('a batch the device rejects surfaces as the home failure', async () => {
  const { interactor, client } = sessionWithClient();
  client.performActions.mockRejectedValueOnce(new Error('buttonDown: unsupported button'));

  await expect(interactor.home!()).rejects.toThrow('buttonDown: unsupported button');
});
