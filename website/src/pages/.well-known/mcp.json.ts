// /.well-known/mcp.json: the stdio MCP server's registry identity, from the repo's server.json,
// with the version set to the latest one published on npm when the site is built. The site
// redeploys on every push to main, so the version follows releases.
import type { APIRoute } from 'astro';

import server from '../../../../server.json';
import { site } from '../../site/content';

async function latestVersion(): Promise<string> {
  try {
    const response = await fetch('https://registry.npmjs.org/agent-device/latest', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    const { version } = (await response.json()) as { version?: string };
    if (response.ok && version) return version;
  } catch {}
  console.warn(`mcp.json: npm is unreachable; using server.json's version ${server.version}.`);
  return server.version;
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
