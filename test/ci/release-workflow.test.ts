import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { parse } from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const source = fs.readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');

type Job = {
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

test('the published bytes are built without a restored dependency cache', () => {
  const setup = workflow.jobs.build?.steps?.find(
    (step) => step.uses === './.github/actions/setup-node-pnpm',
  );
  expect(setup?.with?.['cache-store']).toBe('false');
});
