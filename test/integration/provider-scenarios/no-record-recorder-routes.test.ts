/**
 * `--no-record` must keep an action out of a recorded session script — proven
 * at the RECORDER ROUTE, through the full argv -> reader -> client -> daemon
 * chain, with the written `.ad` as the observable.
 *
 * This is the coverage shape #1304/#1305 lacked. Their assertion stopped at
 * `readInputFromCli`'s intermediate object, so the flag could be (and was)
 * dropped by `readFieldInput` and `to*Options` downstream while the test stayed
 * green. `gesture` (interaction-completion route) and `back`/`home` (generic
 * dispatch route) are the concrete regressions that shipped as a result.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { runCliCommandWithOutput } from '../../../src/commands/cli-runner.ts';
import type { CommandName } from '../../../src/commands/command-metadata.ts';
import { parseArgs } from '../../../src/cli/parser/args.ts';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

test('--no-record keeps gesture/back/home out of a recorded session script', async () => {
  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    const daemon = world.daemon;
    const client = daemon.client();
    const selection = world.selection;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-no-record-routes-'));
    const scriptPath = path.join(tempRoot, 'session.ad');

    // Ordinary (non-repair) authoring recording.
    const open = await daemon.callCommand('open', ['settings'], {
      ...selection,
      saveScript: scriptPath,
    });
    assert.equal(open.statusCode, 200, JSON.stringify(open.json));

    // Every command below goes through the REAL argv -> reader -> client ->
    // daemon chain, exactly as a user types it.
    const runCli = async (argv: string[]) =>
      await runCliCommandWithOutput({
        client,
        command: argv[0] as CommandName,
        positionals: parseArgs(argv, { strictFlags: true }).positionals,
        flags: { ...parseArgs(argv, { strictFlags: true }).flags, ...selection },
      });

    // Control: a recorded action, no flag — must land in the script, proving
    // the recording is live and the absences below are the flag's doing.
    await runCli(['press', '10', '20']);

    // The three routes #1305 missed, each suppressed by --no-record.
    await runCli(['gesture', 'fling', 'up', '100', '200', '--no-record']);
    await runCli(['back', '--no-record']);
    await runCli(['home', '--no-record']);

    const close = await daemon.callCommand('close', [], { saveScript: scriptPath });
    assert.equal(close.statusCode, 200, JSON.stringify(close.json));

    const script = fs.readFileSync(scriptPath, 'utf8');
    const commandsInScript = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('context '))
      .map((line) => line.split(/\s+/)[0]);

    assert.ok(
      commandsInScript.includes('press'),
      `the unflagged control action must be recorded, got:\n${script}`,
    );
    for (const suppressed of ['gesture', 'fling', 'back', 'home']) {
      assert.ok(
        !commandsInScript.includes(suppressed),
        `${suppressed} ran with --no-record but still landed in the recorded script:\n${script}`,
      );
    }

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
}, 20_000);
