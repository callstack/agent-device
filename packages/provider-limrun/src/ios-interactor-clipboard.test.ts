import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';

function sessionWithSimctl(result: { code: number; stdout?: string; stderr?: string }) {
  const simctl = vi.fn(() => ({
    wait: async () => ({ stdout: '', stderr: '', ...result }),
  }));
  const session = {
    platform: 'ios',
    instanceId: 'limrun-clipboard-instance',
    client: { simctl },
  } as unknown as LimrunIosSession;
  return { interactor: createLimrunIosInteractor(session), simctl };
}

test('reads the pasteboard through simctl pbpaste, dropping the trailing newline', async () => {
  const { interactor, simctl } = sessionWithSimctl({ code: 0, stdout: 'first\r\nsecond\n' });

  await expect(interactor.readClipboard!()).resolves.toBe('first\nsecond');
  expect(simctl).toHaveBeenCalledWith(['pbpaste', 'booted'], undefined);
});

test('writes the pasteboard by sending the text to simctl pbcopy on stdin', async () => {
  const { interactor, simctl } = sessionWithSimctl({ code: 0 });

  await interactor.writeClipboard!('hello ✓');

  expect(simctl).toHaveBeenCalledWith(['pbcopy', 'booted'], { stdin: 'hello ✓' });
});

test('a non-zero simctl exit fails with the command, exit code, and stderr', async () => {
  const { interactor } = sessionWithSimctl({ code: 1, stderr: 'pbcopy: refused\n' });

  const failure = await interactor.writeClipboard!('text').catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(AppError);
  expect(failure).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { command: 'pbcopy', exitCode: 1, stderr: 'pbcopy: refused' },
  });
});
