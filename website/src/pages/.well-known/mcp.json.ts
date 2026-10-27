// /.well-known/mcp.json: the stdio MCP server's registry identity, from the repo's server.json,
// with the version set to the latest one published on npm when the site is built. The site
// redeploys on every push to main, so the version follows releases. Without npm the build
// fails: server.json between releases carries an unpublished `-dev` version, and agents would
// be told to install a package that does not exist.
import type { APIRoute } from 'astro';

import server from '../../../../server.json';
import { site } from '../../site/content';

async function latestVersion(): Promise<string> {
  const response = await fetch('https://registry.npmjs.org/agent-device/latest', {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  const { version } = (await response.json()) as { version?: string };
  if (!response.ok || !version) {
    throw new Error(
      `mcp.json: npm did not return the published version (HTTP ${response.status}).`,
    );
  }
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
