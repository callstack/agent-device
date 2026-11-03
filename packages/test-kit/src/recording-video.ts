import fs from 'node:fs';
import { prepareVideoValidator } from '@agent-device/capture-kit/recording-video';
import { withCommandExecutorOverride } from '@agent-device/host-kit/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

/** Prepares validation for synthetic recording fixtures without host Swift tools. */
export async function prepareRecordingValidatorFixture(host: HostEnvironment): Promise<void> {
  await withCommandExecutorOverride(
    (command, args) => {
      if (command !== 'xcrun' || args[0] !== 'swiftc') {
        throw new Error(`Unexpected validator preparation command: ${command}`);
      }
      const [outputFlag, output] = args.slice(-2);
      if (outputFlag !== '-o' || !output)
        throw new Error('Swift compiler fixture received no executable output');
      fs.writeFileSync(output, `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    },
    async () => {
      await prepareVideoValidator(host);
    },
  );
}
