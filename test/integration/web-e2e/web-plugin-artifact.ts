import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { formatResultDebug, runBuiltCliJson } from '../cli-json.ts';

let tarball: string | undefined;

function webPluginArtifact(): string {
  if (tarball) return tarball;
  const scratch = mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'agent-device-web-plugin-'));
  const output = path.join(scratch, 'web.tgz');
  execFileSync('pnpm', ['pack', '--out', output], {
    cwd: path.resolve(import.meta.dirname, '../../../packages/platform-web'),
    env: process.env,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  tarball = output;
  return output;
}

export async function installWebPluginForSmoke(env: NodeJS.ProcessEnv): Promise<void> {
  const args = ['plugins', 'add', webPluginArtifact(), '--json'];
  const result = await runBuiltCliJson(args, env);
  assert.equal(result.status, 0, formatResultDebug('install web plugin', args, result));
}

export async function stopWebPluginSmokeDaemon(env: NodeJS.ProcessEnv): Promise<void> {
  const args = ['daemon', 'stop', '--json'];
  const result = await runBuiltCliJson(args, env);
  assert.equal(result.status, 0, formatResultDebug('stop web smoke daemon', args, result));
}
