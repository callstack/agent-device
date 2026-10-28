// /.well-known/mcp.json: the stdio MCP server's registry identity, from the repo's server.json,
// with the version set to the latest one published on npm when the site is built. The release
// workflow (release.yml, redeploy-site) rebuilds the site right after each stable release, so
// the version follows releases. Without npm the build fails: server.json between releases
// carries an unpublished `-dev` version, and agents would be told to install a package that
// does not exist.
import type { APIRoute } from 'astro';

import server from '../../../../server.json';
import { site } from '../../site/content';

const REGISTRY = 'https://registry.npmjs.org/agent-device/latest';

async function latestVersion(): Promise<string> {
  let response: Response;
  try {
    response = await fetch(REGISTRY, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(
      `mcp.json: the site build reads the published version from ${REGISTRY}, and the request failed or timed out. A host without network access, or a slow registry, is an infrastructure fault, not a site bug.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new Error(
      `mcp.json: npm did not return the published version (HTTP ${response.status}).`,
    );
  }
  const { version } = (await response.json()) as { version?: string };
  if (!version) throw new Error('mcp.json: the npm response has no version for agent-device.');
  return version;
}

export const GET: APIRoute = async () => {
  const version = await latestVersion();
  const manifest = {
    ...server,
    websiteUrl: site.url,
    version,
    packages: server.packages.map((p) => ({ ...p, version })),
  };
  return new Response(`${JSON.stringify(manifest, null, 2)}\n`, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
