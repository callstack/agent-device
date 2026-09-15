import { expect, test, vi } from 'vitest';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';

function sessionWithClient() {
  const client = {
    tap: vi.fn(async () => {}),
    performActions: vi.fn(async () => ({ results: [] })),
  };
  const session = {
    platform: 'ios',
    instanceId: 'limrun-double-tap-instance',
    client,
  } as unknown as LimrunIosSession;
  return { interactor: createLimrunIosInteractor(session), client };
}

test('double tap sends both taps in one batch with the pause enforced on the device', async () => {
  const { interactor, client } = sessionWithClient();

  await interactor.doubleTap(120, 340);

  expect(client.performActions).toHaveBeenCalledTimes(1);
  expect(client.performActions).toHaveBeenCalledWith([
    { type: 'tap', x: 120, y: 340 },
    { type: 'wait', durationMs: 80 },
    { type: 'tap', x: 120, y: 340 },
  ]);
  expect(client.tap).not.toHaveBeenCalled();
});

test('a batch the device rejects surfaces as the double tap failure', async () => {
  const { interactor, client } = sessionWithClient();
  client.performActions.mockRejectedValueOnce(new Error('tap: no foreground application'));

  await expect(interactor.doubleTap(120, 340)).rejects.toThrow('tap: no foreground application');
});
