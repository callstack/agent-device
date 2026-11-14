import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const source = fs.readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');

type Job = {
  'cache-mode'?: string;
  environment?: string;
  permissions?: Record<string, string>;
  steps?: Array<{ uses?: string; with?: Record<string, string> }>;
  uses?: string;
};
const workflow = parse(source) as { permissions: unknown; jobs: Record<string, Job> };

// npm trusts release.yml in the npm-publish environment, so whichever job can mint an id-token
// can publish. Only the publisher and the MCP Registry call (its own OIDC login) may.
test('only the npm publisher and the MCP Registry call can mint an id-token', () => {
  expect(workflow.permissions).toEqual({});
  const minting = Object.entries(workflow.jobs)
    .filter(([, job]) => job.permissions?.['id-token'] === 'write')
    .map(([name]) => name);
  expect(minting.sort()).toEqual(['mcp-registry', 'publish']);
  expect(workflow.jobs['mcp-registry']?.uses).toBe('./.github/workflows/publish-mcp-registry.yml');
  expect(workflow.jobs.publish?.environment).toBe('npm-publish');
});

/** The secret names a job references, wherever in the job they appear. */
const secretsOf = (job: Job) =>
  [...JSON.stringify(job).matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(([, name]) => name);

test('the publisher authenticates through OIDC alone', () => {
  expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  // No secret reaches the jobs that build or publish the packages. The one secret in the file
  // is the site's deploy hook, which only the redeploy job after a stable release reads.
  expect(secretsOf(workflow.jobs.publish ?? {})).toEqual([]);
  expect(secretsOf(workflow.jobs.build ?? {})).toEqual([]);
  const withSecrets = Object.entries(workflow.jobs)
    .map(([name, job]) => [name, secretsOf(job)] as const)
    .filter(([, names]) => names.length > 0);
  expect(withSecrets).toEqual([['redeploy-site', ['VERCEL_SITE_DEPLOY_HOOK']]]);
  const setupNode = workflow.jobs.publish?.steps?.find((step) =>
    step.uses?.startsWith('actions/setup-node@'),
  );
  expect(setupNode?.with).not.toHaveProperty('registry-url');
});

test('the release build has no cache token access and restores no dependency cache', () => {
  expect(workflow.jobs.build?.['cache-mode']).toBe('none');
  const setup = workflow.jobs.build?.steps?.find(
    (step) => step.uses === './.github/actions/setup-node-pnpm',
  );
  expect(setup?.with?.['cache-store']).toBe('false');
});

test('the source checkout and artifact identity use the planned commit while the publisher stays trusted', () => {
  const build = workflow.jobs.build?.steps ?? [];
  const checkout = build.find((step) => step.uses?.startsWith('actions/checkout@'));
  expect(checkout?.with?.ref).toBe('${{ needs.plan.outputs.commit }}');
  const upload = build.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  expect(upload?.with?.name).toBe('npm-packages-${{ needs.plan.outputs.commit }}');
  const publisher = workflow.jobs.publish?.steps ?? [];
  expect(
    publisher.find((step) => step.uses?.startsWith('useblacksmith/checkout@'))?.with?.ref,
  ).toBe('${{ github.workflow_sha }}');
  expect(
    publisher.find((step) => step.uses?.startsWith('actions/download-artifact@'))?.with?.name,
  ).toBe(upload?.with?.name);
});

test('version stamping uses tooling pinned to the workflow commit', () => {
  const tooling = workflow.jobs.build?.steps?.find((step) => step.with?.path === '.release-tools');
  expect(tooling?.with?.ref).toBe('${{ github.workflow_sha }}');
});
