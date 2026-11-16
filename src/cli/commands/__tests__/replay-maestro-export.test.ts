import { installedReplayCliTestEnv } from '../../../__tests__/cli-test-env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { getReplayBackend } from '@agent-device/replay-port/replay-backend-registry';
import { runCliCapture } from '../../../__tests__/cli-capture.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

describe('exportReplayScriptToMaestro', () => {
  test.each([
    ['tel:+15551234567', false],
    ['tel:+15551234567', true],
    ['mailto:agent@example.test', false],
    ['mailto:agent@example.test', true],
  ] as const)('CLI exports %s with explicit app=%s locally', async (link, withApp) => {
    const dir = mkdtempForTestSync('agent-device-export-links-');
    const sourcePath = path.join(dir, 'flow.ad');
    const outPath = path.join(dir, 'flow.yaml');
    const open = withApp ? `com.example.app ${link} --relaunch` : link;
    fs.writeFileSync(sourcePath, `open ${open}\n`);

    const env = installedReplayCliTestEnv();
    const result = await runCliCapture(['replay', 'export', sourcePath, '--json'], { env });

    expect(result.code).toBeNull();
    expect(result.calls).toEqual([]);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    expect(output).toEqual({
      success: true,
      data: { format: 'maestro', sourcePath, yaml: expect.any(String), warnings: [] },
    });
    expect(parseYamlDocs(output.data.yaml)).toEqual(
      withApp
        ? [
            { appId: 'com.example.app' },
            [{ launchApp: { appId: 'com.example.app', stopApp: true } }, { openLink: link }],
          ]
        : [[{ openLink: link }]],
    );

    const written = await runCliCapture(['replay', 'export', sourcePath, '--out', outPath], {
      env,
    });

    expect(written).toMatchObject({ code: null, calls: [], stderr: '', stdout: `${outPath}\n` });
    expect(fs.readFileSync(outPath, 'utf8')).toBe(output.data.yaml);
  });
});

function parseYamlDocs(script: string): unknown[] {
  return parseAllDocuments(script).map((doc) => doc.toJSON());
}

test('replay export prints each warning as one folded Warning line', async () => {
  const dir = mkdtempForTestSync('agent-device-export-warning-');
  const sourcePath = path.join(dir, 'flow.ad');
  fs.writeFileSync(sourcePath, 'open com.example.app\n');
  // The CLI reads the cached Maestro backend, so the stub reaches it; an export warning can carry a newline.
  const backend = await getReplayBackend('maestro');
  const exportScript = vi.spyOn(backend, 'exportReplayScript').mockReturnValue({
    yaml: '- launchApp\n',
    warnings: [{ line: 1, action: 'open', message: 'first part\nsecond part' }],
  });
  onTestFinished(() => exportScript.mockRestore());

  const result = await runCliCapture([
    'replay',
    'export',
    sourcePath,
    '--out',
    path.join(dir, 'flow.yaml'),
  ]);

  expect(result.stderr).toBe('Warning: line 1: first part second part\n');
});
