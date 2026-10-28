// /version.txt: the commit this site was built from (VERCEL_GIT_COMMIT_SHA on Vercel, "local"
// elsewhere). deploy.yml waits until agent-device.dev serves a commit at or after its own before it
// copies the docs for the oss.callstack.com redirects.
import type { APIRoute } from 'astro';

export const GET: APIRoute = () =>
  new Response(`${process.env.VERCEL_GIT_COMMIT_SHA ?? 'local'}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
