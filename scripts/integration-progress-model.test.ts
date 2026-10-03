import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { buildIntegrationProgressModel } from './integration-progress-model.ts';

test('integration progress counts explicit generic Apple host-tool usage only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-device-progress-'));
  try {
    const scenarioDir = path.join(root, 'test/integration/provider-scenarios');
    await mkdir(scenarioDir, { recursive: true });
    await writeFile(
      path.join(scenarioDir, 'workflow.test.ts'),
      [
        "const steps = [{ command: 'open' }];",
        "await daemon.callCommand('open', ['settings']);",
        "assertFlatToolCall(appleTool.calls, ['simctl', 'pbcopy', 'sim-1']);",
        "assertFlatToolCall(appleTool.calls, ['pkill', '-TERM', '-P', '1234']);",
        "await provider.runCommand('mdfind', ['kMDItemCFBundleIdentifier == com.example']);",
      ].join('\n'),
    );

    const progress = buildIntegrationProgressModel({ root });
    const appleGeneric = progress.providerPressureRows.find(
      (row) => row.name === 'Apple generic host-tool provider',
    );

    assert.equal(appleGeneric?.references, 2);
    assert.equal(appleGeneric?.files, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('integration progress maps a parameterless facet to its client method', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-device-progress-'));
  try {
    const commandsDir = path.join(root, 'src/commands/system');
    const scenarioDir = path.join(root, 'test/integration/provider-scenarios');
    await mkdir(commandsDir, { recursive: true });
    await mkdir(scenarioDir, { recursive: true });
    await writeFile(
      path.join(commandsDir, 'index.ts'),
      [
        "const HOME_COMMAND_NAME = 'home';",
        'const homeCommandFacet = defineParameterlessCommandFacet({',
        '  name: HOME_COMMAND_NAME,',
        '  run: (client, input) => client.command.home(input),',
        '});',
      ].join('\n'),
    );
    await writeFile(
      path.join(scenarioDir, 'system.test.ts'),
      'const home = await client.command.home(selection);\n',
    );

    const progress = buildIntegrationProgressModel({ root });
    const home = progress.publicCommandRows.find((row) => row.command === 'home');

    assert.equal(home?.references, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
