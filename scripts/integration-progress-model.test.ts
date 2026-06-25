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
