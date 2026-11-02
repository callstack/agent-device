import { expect, test, vi } from 'vitest';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';
import { createTestIosRunner, iosRunnerDevice } from './ios-runner.fixtures.ts';

test('an opened app remains the shared runner target across requests and home does not change it', async () => {
  const commands: Record<string, unknown>[] = [];
  const runner = await createTestIosRunner((command) => {
    commands.push(command);
    return {
      nodes: [
        {
          index: 0,
          type: 'Application',
          label: 'Settings',
          rect: { x: 0, y: 0, width: 390, height: 844 },
        },
      ],
    };
  });
  const createInteractor = runner.createInteractor;
  runner.createInteractor = (context) => ({
    ...createInteractor(context),
    open: async () => {},
    close: async () => {},
  });
  vi.spyOn(runner.applicationTools, 'resolveOpenTarget').mockImplementation(
    async (_device, input) => ({
      appBundleId: input.target === 'settings' ? 'com.apple.Preferences' : input.target,
    }),
  );
  const elementTree = vi.fn(() => {
    throw new Error('AX capture must not run');
  });
  const session = {
    device: iosRunnerDevice,
    runner,
    client: { elementTree, launchApp: async () => {} },
    dependencies: { ios: { resolveAppAlias: async () => 'com.apple.Preferences' } },
  } as unknown as LimrunIosSession;
  const interactor = createLimrunIosInteractor(session);
  await interactor.open('settings');
  await interactor.snapshot({ depth: 3, interactiveOnly: true });
  expect(commands.at(-1)).toMatchObject({
    command: 'snapshot',
    appBundleId: 'com.apple.Preferences',
    depth: 3,
    interactiveOnly: true,
  });
  await interactor.home!();
  expect(commands.at(-1)).toMatchObject({ command: 'home', appBundleId: 'com.apple.Preferences' });
  await createLimrunIosInteractor(session).snapshot();
  expect(commands.at(-1)).toMatchObject({
    command: 'snapshot',
    appBundleId: 'com.apple.Preferences',
  });
  await createLimrunIosInteractor(session).snapshot({ appBundleId: 'com.example.other' });
  expect(commands.at(-1)?.appBundleId).toBe('com.example.other');
  await interactor.close('com.example.other');
  await createLimrunIosInteractor(session).snapshot();
  expect(commands.at(-1)?.appBundleId).toBe('com.apple.Preferences');
  await interactor.close('settings');
  await expect(createLimrunIosInteractor(session).snapshot()).rejects.toMatchObject({
    code: 'INVALID_ARGS',
  });
  expect(elementTree).not.toHaveBeenCalled();
});
