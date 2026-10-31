import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { commandSupportsSettleObservation } from '@agent-device/command-registry/registry';
import { listCliOutputFormatters } from './cli-output.ts';

const SETTLE_OBSERVATION_COMMANDS = [
  PUBLIC_COMMANDS.click,
  PUBLIC_COMMANDS.fill,
  PUBLIC_COMMANDS.longPress,
  PUBLIC_COMMANDS.hover,
  PUBLIC_COMMANDS.press,
  PUBLIC_COMMANDS.scroll,
  PUBLIC_COMMANDS.back,
] as const;

test('post-action observation CLI output formatters follow descriptor traits', async () => {
  const formatters = listCliOutputFormatters();
  for (const command of SETTLE_OBSERVATION_COMMANDS) {
    assert.ok(formatters[command], `${command}: missing CLI output formatter`);
  }
  const settledResult = { message: 'ok', settle: { settled: true, waitedMs: 12 } };
  for (const [command, format] of Object.entries(formatters)) {
    let text: string;
    try {
      text = String(
        (await format({ env: process.env, stderrIsTTY: false, input: {}, result: settledResult }))
          .text ?? '',
      );
    } catch {
      // Formatters expecting a differently-shaped result (device lists) are
      // orthogonal to settle rendering — but a settle-capable formatter must
      // cope with a settled response.
      assert.equal(
        commandSupportsSettleObservation(command),
        false,
        `${command}: settle-capable formatter must render the settled result`,
      );
      continue;
    }
    assert.equal(
      text.includes('settled after'),
      commandSupportsSettleObservation(command),
      `${command}: settle rendering must match descriptor trait`,
    );
  }
});
