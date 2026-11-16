import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { expect } from 'vitest';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { materializeRemoteArtifacts } from '../../daemon-artifacts.ts';
import { sendRemoteScriptOpen } from '../../session-script-destination.ts';

/**
 * Fixtures for the remote `batch` script delivery: a daemon that serves the script versions it is
 * given, a client that armed one recording, and the shapes that runner answers with.
 */

const servers: http.Server[] = [];

/** Closes every server this module started. Each suite calls it from `afterEach`. */
export async function closeArtifactServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => closeLoopbackServer(server)));
}

/**
 * Serves the script versions it is given, and records what it was asked for. An artifact ID it does
 * not know answers 503, which is how these tests make a download fail.
 */
export async function artifactServer(
  bodies: Record<string, string>,
  requested: string[] = [],
): Promise<string> {
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url?.replace('/artifacts/', '') ?? '');
    requested.push(id);
    const body = bodies[id];
    if (body === undefined) {
      res.writeHead(503).end('unavailable');
      return;
    }
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  servers.push(server);
  return `http://127.0.0.1:${await listenOnLoopback(server)}`;
}

export function journey(): Readonly<{ destination: string; root: string; stateDir: string }> {
  // The real path, so a destination names the same file the publication renames into place.
  const root = fs.realpathSync(mkdtempForTestSync('batch-script-'));
  return { root, stateDir: path.join(root, 'state'), destination: path.join(root, 'journey.ad') };
}

export function request(
  command: string,
  meta: DaemonWireRequest['meta'] = {},
  flags?: DaemonWireRequest['flags'],
): DaemonWireRequest {
  return {
    token: 't',
    session: 'journey',
    command,
    positionals: [],
    ...(flags ? { flags } : {}),
    meta,
  };
}

/**
 * The plan a `batch` request carries: the daemon answers one entry per submitted step, and the
 * client authorizes delivery only for the steps IT submitted (#4564 review).
 */
export function batchPlan(...commands: string[]): DaemonWireRequest['flags'] {
  return { batchSteps: commands.map((command) => ({ command })) };
}

export function script(
  artifactId: string,
  revision: number,
  publicationId: string,
): DaemonArtifact {
  return {
    field: 'savedScript',
    artifactType: 'session-script',
    artifactId,
    scriptPublicationId: publicationId,
    scriptRevision: revision,
  };
}

/** The failure the DAEMON writes when it could not save its own version of the recording. */
export function daemonFailure(publicationId: string, revision: number) {
  return {
    reason: 'script_delivery_failed',
    cause: 'script_write_failed',
    publicationId,
    message: `The session recorded version ${revision}, but the daemon could not save it.`,
    hint: 'The file keeps the version from the last action that arrived.',
  };
}

export function records(stateDir: string): string[] {
  const directory = path.join(stateDir, 'remote-connections', 'session-scripts');
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((n) => n.endsWith('.json'))
    : [];
}

/** Answers a request the way the daemon does and materializes the answer like the client. */
export function answer(
  baseUrl: string,
  stateDir: string,
  req: DaemonWireRequest,
  data: Record<string, unknown>,
): Promise<DaemonResponse> {
  return materializeRemoteArtifacts(
    { baseUrl, token: 't' },
    req,
    { ok: true, data },
    createTestHostEnvironment(),
    stateDir,
  );
}

/** One batch step result, shaped the way the daemon runner answers. */
export function step(step: number, command: string, data: Record<string, unknown>) {
  return { step, command, ok: true, data, durationMs: 1 };
}

/** A remote `open --save-script` the daemon answered with version 1. */
export async function open(baseUrl: string, stateDir: string, destination: string) {
  let publicationId = '';
  await sendRemoteScriptOpen(
    { baseUrl, token: 't', capabilities: ['script-artifacts'] },
    {
      ...request('open', { clientArtifactPaths: { savedScript: destination } }),
      flags: { saveScript: true },
    },
    stateDir,
    async (next) => {
      publicationId = next.meta?.scriptPublicationId as string;
      return await answer(baseUrl, stateDir, next, {
        scriptPublicationId: publicationId,
        artifacts: [script('v1', 1, publicationId)],
      });
    },
  );
  return publicationId;
}

/** The step results of a successful batch answer. */
export function batchSteps(response: DaemonResponse): Array<Record<string, any>> {
  if (!response.ok) throw new Error(`Expected a successful batch, got ${JSON.stringify(response)}`);
  return (response.data?.results ?? []) as Array<Record<string, any>>;
}

/** The batch's own payload fields. */
export function payload(response: DaemonResponse): Record<string, any> {
  if (!response.ok) throw new Error(`Expected a successful batch, got ${JSON.stringify(response)}`);
  return response.data ?? {};
}

/**
 * Nothing was delivered: no field names a caller file, no artifact reports a published local path,
 * and no delivery failure is claimed. The daemon's own artifact entries stay in the answer, field
 * names and all, so the answer is checked for what this client would have added.
 */
export function expectDeliveredNothing(response: DaemonResponse): void {
  const text = JSON.stringify(response);
  expect(text).not.toContain('"savedScript":');
  expect(text).not.toContain('"localPath":');
  expect(text).not.toContain('"scriptDeliveryFailure":');
}
