import { expect, test } from 'vitest';
import { waitCommandFacet } from './wait.ts';

/**
 * A `wait` that timed out or settled after the runner re-activated the session app consumed a capture
 * that repaired foreground (#2682). Its text formatter is the shared warning renderer, so the agent
 * reads the disclosure instead of finding it only in `--json`.
 */
test('wait renders the disclosure the capture response carried', async () => {
  const formatter = waitCommandFacet.cliOutputFormatter;
  expect(formatter).toBeDefined();
  const output = await formatter!({
    input: {},
    result: {
      message: 'Text "Receipt" appeared',
      warnings: [
        'The session app was not foreground when this command arrived (prior state runningBackground).',
      ],
    },
  });
  expect(output.text).toBe(
    'Text "Receipt" appeared\nWarning: The session app was not foreground when this command arrived (prior state runningBackground).',
  );
});
