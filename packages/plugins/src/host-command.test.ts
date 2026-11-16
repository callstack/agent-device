import { expect, test } from 'vitest';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import { createPluginHost } from './host.ts';

test('plugin host runs commands with the AWS command bounds', async () => {
  await withCommandExecutorOverride(
    async (command, args, options) => {
      expect(command).toBe('aws');
      expect(args).toEqual(['devicefarm', 'get-project']);
      expect(options.maxBuffer).toBe(10 * 1024 * 1024);
      expect(options.timeoutMs).toBe(30_000);
      return { stdout: '{"project":{}}', stderr: '', exitCode: 0 };
    },
    async () => {
      await expect(
        createPluginHost({}, undefined).runHostCommand('aws', ['devicefarm', 'get-project']),
      ).resolves.toEqual({ stdout: '{"project":{}}' });
    },
  );
});
