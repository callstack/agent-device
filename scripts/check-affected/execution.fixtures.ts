import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCmdSync } from '@agent-device/host-kit/command';
import type { ExecutionReceipt } from './execution.ts';

export const entry = pathToFileURL(path.join(import.meta.dirname, 'execution.ts')).href;

export function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'validation-execution-'));
  const git = (...args: string[]) => runCmdSync('git', args, { cwd }).stdout.trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.tmp\n.cache\n');
  fs.writeFileSync(path.join(cwd, 'source.txt'), 'base');
  git('add', '.');
  git('commit', '-qm', 'base');
  const sha = git('rev-parse', 'HEAD');
  return { cwd, git, sha };
}

export function run(cwd: string, head: string, body: string) {
  const result = runCmdSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `
    import { runValidation } from ${JSON.stringify(entry)};
    const code = await runValidation(${JSON.stringify(cwd)}, { base: 'HEAD', head: ${JSON.stringify(head)}, json: true }, async ({execute, receipt}) => {
      ${body}
    });
    process.exitCode = code;
  `,
    ],
    {
      cwd,
      allowFailure: true,
      env: { ...process.env, HOME: cwd, USERPROFILE: cwd, AGENT_DEVICE_VALIDATION_PARENT: '' },
    },
  );
  return { ...result, receipt: JSON.parse(result.stdout) as ExecutionReceipt };
}
