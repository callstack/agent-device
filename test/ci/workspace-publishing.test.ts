import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, '../../.github/workflows/publish-workspace-package.yml'),
    'utf8',
  ),
);

test('publishing requires explicit dispatch, dry-run opt-out, and a protected environment', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch.inputs.dry_run.default).toBe(true);
  expect(workflow.jobs.prepare.if).toBe("github.ref == 'refs/heads/main'");
  expect(workflow.jobs.publish.if).toBe('${{ !inputs.dry_run }}');
  expect(workflow.jobs.publish.environment).toBe('npm-publish');
  expect(workflow.concurrency['cancel-in-progress']).toBe(false);
});

test('install and pack cannot mint publishing credentials; publication consumes the validated artifact', () => {
  expect(workflow.permissions['id-token']).toBeUndefined();
  expect(workflow.jobs.prepare.permissions?.['id-token']).toBeUndefined();
  const publish = workflow.jobs.publish;
  expect(publish.needs).toBe('prepare');
  expect(publish.permissions['id-token']).toBe('write');
  for (const step of publish.steps) {
    if (step.uses) expect(step.uses).toMatch(/^actions\/(setup-node|download-artifact)@/);
    if (step.run) {
      expect(step.run).toMatch(/^npm publish release\/package.tgz .*--ignore-scripts/);
      expect(step.run).not.toMatch(/pnpm|npm install|&&|;/);
    }
    expect(step.env?.NODE_AUTH_TOKEN).toBeUndefined();
  }
  const upload = workflow.jobs.prepare.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('actions/upload-artifact@'),
  );
  const download = publish.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith('actions/download-artifact@'),
  );
  expect(upload.with.name).toBe(download.with.name);
  expect(upload.with.path).toBe('${{ steps.package.outputs.tarball }}');
  expect(upload.with['if-no-files-found']).toBe('error');
});
