import { installedMaestroCliTestEnv } from '../../../__tests__/cli-test-env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { parseAllDocuments } from 'yaml';
import { describe, expect, test } from 'vitest';
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

    const env = installedMaestroCliTestEnv();
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
