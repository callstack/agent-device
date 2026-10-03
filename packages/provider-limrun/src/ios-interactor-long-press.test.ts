import { expect, test, vi } from 'vitest';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';

function sessionWithClient() {
  const client = {
    tap: vi.fn(async () => {}),
    performActions: vi.fn(async () => ({ results: [] })),
  };
  const session = {
    platform: 'ios',
    instanceId: 'limrun-long-press-instance',
    client,
  } as unknown as LimrunIosSession;
  return { interactor: createLimrunIosInteractor(session), client };
}

test('long press holds one touch on the device for the requested duration', async () => {
  const { interactor, client } = sessionWithClient();

  await interactor.longPress(120, 340, 1200);

  expect(client.performActions).toHaveBeenCalledTimes(1);
  expect(client.performActions).toHaveBeenCalledWith([
    { type: 'touchDown', x: 120, y: 340 },
    { type: 'wait', durationMs: 1200 },
    { type: 'touchUp', x: 120, y: 340 },
  ]);
  expect(client.tap).not.toHaveBeenCalled();
});

test('an omitted duration holds for the 800 ms the other interactors default to', async () => {
  const { interactor, client } = sessionWithClient();

  await interactor.longPress(40, 60);

  expect(client.performActions).toHaveBeenCalledWith([
    { type: 'touchDown', x: 40, y: 60 },
    { type: 'wait', durationMs: 800 },
    { type: 'touchUp', x: 40, y: 60 },
  ]);
});

test('a batch the device rejects surfaces as the long press failure', async () => {
  const { interactor, client } = sessionWithClient();
  client.performActions.mockRejectedValueOnce(new Error('touchDown: no foreground application'));

  await expect(interactor.longPress(120, 340, 500)).rejects.toThrow(
    'touchDown: no foreground application',
  );
});
