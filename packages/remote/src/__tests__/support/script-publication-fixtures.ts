import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { onTestFinished } from 'vitest';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import {
  closeLoopbackServer,
  createTestHostEnvironment,
  listenOnLoopback,
} from '@agent-device/test-kit';
import { materializeRemoteArtifacts } from '../../daemon-artifacts.ts';
import { sendRemoteScriptOpen } from '../../session-script-destination.ts';

/**
 * The client side of a remote script publication: a daemon that serves versions over HTTP, and the `open`
 * that arms a publication and downloads its first version. Shared because two files pin this route —
 * `daemon-artifacts-script-download` for what a publication records and delivers, and
 * `daemon-artifacts-script-ancestry` for the ground a destination may be created in.
 */

/** What one artifact route of the fake daemon serves. */
export type Served = { body: string; broken?: boolean; endless?: boolean };

/**
 * A daemon that serves script versions over HTTP. Closed when the calling test finishes, so a suite that
 * opens several publications leaves no listener behind.
 */
export async function artifactServer(artifacts: Record<string, Served>): Promise<string> {
  const server = http.createServer((req, res) => {
    const artifact = artifacts[decodeURIComponent(req.url?.replace(/^\/+artifacts\//, '') ?? '')];
    if (!artifact) {
      res.writeHead(404).end();
      return;
    }
    if (artifact.endless) {
      res.writeHead(200);
      const write = () => {
        if (!res.destroyed) res.write(artifact.body, () => setImmediate(write));
      };
      write();
      return;
    }
    res.writeHead(200, { 'content-length': Buffer.byteLength(artifact.body) });
    if (!artifact.broken) {
      res.end(artifact.body);
      return;
    }
    res.flushHeaders();
    res.write(artifact.body.slice(0, 4));
    setImmediate(() => res.destroy());
  });
  onTestFinished(() => closeLoopbackServer(server));
  return `http://127.0.0.1:${await listenOnLoopback(server)}`;
}

export function request(command: string, meta: DaemonWireRequest['meta'] = {}): DaemonWireRequest {
  return { token: 't', session: 'journey', command, positionals: [], meta };
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

/** The publication records the client has written for this state directory. */
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
  const info = { baseUrl, token: 't' };
  return materializeRemoteArtifacts(
    info,
    req,
    { ok: true, data },
    createTestHostEnvironment(),
    stateDir,
  );
}

/** A remote `open --save-script`: the daemon arms the publication it is sent, with version 1. */
export async function open(
  baseUrl: string,
  stateDir: string,
  destination: string,
  options: { force?: boolean; respond?: (id: string) => DaemonResponse } = {},
) {
  let sent: DaemonWireRequest | undefined;
  let recordsAtSend: string[] = [];
  const req = {
    ...request('open', { clientArtifactPaths: { savedScript: destination } }),
    flags: { saveScript: true, ...(options.force ? { force: true } : {}) },
  };
  const info = { baseUrl, token: 't', capabilities: ['script-artifacts'] };
  const response = await sendRemoteScriptOpen(info, req, stateDir, async (next) => {
    sent = next;
    recordsAtSend = records(stateDir);
    const id = next.meta?.scriptPublicationId as string;
    const reply = options.respond?.(id);
    if (reply) return reply;
    return answer(baseUrl, stateDir, next, {
      scriptPublicationId: id,
      artifacts: [script('v1', 1, id)],
    });
  });
  const id = sent?.meta?.scriptPublicationId as string;
  return { id, sent, recordsAtSend, response };
}
