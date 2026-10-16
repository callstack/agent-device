import { runCmdStreaming } from '@agent-device/host-kit/command';
import { runEntrypoint } from '../lib/cli-entrypoint.ts';

// The parent publishes group ownership before sending activation. EOF before activation cannot start a check.
runEntrypoint('validation command', async () => {
  let activation = '';
  for await (const chunk of process.stdin) activation += String(chunk);
  if (activation !== 'run\n') return 1;
  const [command, ...args] = process.argv.slice(2);
  if (!command) return 1;
  const result = await runCmdStreaming(command, args, {
    allowFailure: true,
    captureOutput: false,
    onStdoutChunk: (chunk) => {
      process.stdout.write(chunk);
    },
    onStderrChunk: (chunk) => {
      process.stderr.write(chunk);
    },
  });
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) =>
        new Promise<void>((resolve, reject) =>
          stream.write('', (error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  return result.exitCode;
});
