// Daemon-side stand-in for the client's replay source collection (#1802). The root
// `src/__tests__/test-utils/replay-script-source.ts` runs the real client-side collector
// (`src/commands/replay/*`); daemon policy tests only need the SHAPE of the bundles a real
// request carries, so this builds them from the package-owned format resolution and
// Maestro include engine without reaching into the root command layer. Suite expansion
// stands in with a deterministic walk; the daemon never expands inputs itself (#1802).
import fs from 'node:fs';
import path from 'node:path';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';
import type { MaestroSourceReader } from '@agent-device/maestro';
import { resolveUserPath } from '@agent-device/host-kit/file';
import { resolveReplayFormat } from '@agent-device/ad-script';
import type { DaemonRequest } from '../../daemon-request.ts';

/** A native `.ad` script's one-entry source bundle for test requests. */
export function replayScriptSourceBundleFor(filePath: string): ReplayScriptSourceBundle {
  const entry = resolveUserPath(filePath, { cwd: process.cwd() });
  return { entry, files: { [entry]: fs.readFileSync(entry, 'utf8') } };
}

/** A Maestro flow's bundle — async because the engine that walks its includes loads on demand. */
export async function maestroScriptSourceBundleFor(
  filePath: string,
): Promise<ReplayScriptSourceBundle> {
  return await collectReplayScriptSourceBundle({
    inputPath: filePath,
    cwd: process.cwd(),
    replayBackend: 'maestro',
  });
}

/**
 * `readSource` for a flow that declares no `runFlow` includes: the engine must
 * never reach for one, so a call here means the fixture drifted rather than a
 * missing file.
 */
export const noMaestroIncludeSources: MaestroSourceReader = (resolvedPath) => {
  throw new Error(`unexpected Maestro include read: ${resolvedPath}`);
};

/**
 * Attaches the script sources a real client would have collected for a `replay`/`test` request
 * (#1802): the daemon opens no caller path, so every request that reaches one carries them.
 * Test harnesses that stand in for "a request as it arrives at the daemon" call this so their
 * cases keep expressing what they are about; a request that already carries its own sources (or
 * deliberately carries none, to pin the daemon's refusal) is returned untouched.
 *
 * Collection that cannot succeed — a case driving `replay` at a path that deliberately does not
 * exist — leaves the request alone rather than throwing: the real client raises that failure at
 * the CLI boundary (pinned in `cli-client-commands.test.ts`), and a daemon-level harness must
 * still deliver the request so the daemon's own response is what the case observes.
 */
export async function withClientReplayScriptSources(req: DaemonRequest): Promise<DaemonRequest> {
  if (req.command !== 'replay' && req.command !== 'test') return req;
  const inputs = req.positionals ?? [];
  const entryPath = inputs[0];
  if (entryPath === undefined) return req;
  const cwd = req.meta?.cwd ?? process.cwd();
  const replayBackend = req.flags?.replayBackend;
  try {
    if (req.command === 'replay') {
      if (req.flags?.replayScriptSource) return req;
      return withFlags(req, {
        replayScriptSource: await collectReplayScriptSourceBundle({
          inputPath: entryPath,
          cwd,
          replayBackend,
        }),
      });
    }
    if (req.flags?.replayScriptSources) return req;
    return withFlags(req, {
      replayScriptSources: await Promise.all(
        discoverReplaySourcePaths({ inputs, cwd, replayBackend }).map(
          async (inputPath) =>
            await collectReplayScriptSourceBundle({ inputPath, cwd, replayBackend }),
        ),
      ),
    });
  } catch {
    return req;
  }
}

function withFlags(req: DaemonRequest, flags: Partial<DaemonRequest['flags']>): DaemonRequest {
  return { ...req, flags: { ...(req.flags ?? {}), ...flags } };
}

async function collectReplayScriptSourceBundle(params: {
  inputPath: string;
  cwd: string;
  replayBackend?: string;
}): Promise<ReplayScriptSourceBundle> {
  const entry = resolveUserPath(params.inputPath, { cwd: params.cwd });
  const entrySource = fs.readFileSync(entry, 'utf8');
  const backendId = resolveReplayFormat(entry, params.replayBackend);
  if (backendId === 'ad') return { entry, files: { [entry]: entrySource } };
  // Same lazy-load shape as the client collector: the Maestro engine (and its include walker)
  // sits behind the package backend registry, never behind root command code.
  const backend = await (
    await import('@agent-device/replay-port/replay-backend-registry')
  ).getReplayBackend(backendId);
  return {
    entry,
    files: backend.collectSourceFiles({
      entryPath: entry,
      entrySource,
      readSource: (resolvedPath: string) => {
        try {
          return fs.readFileSync(resolvedPath, 'utf8');
        } catch {
          return undefined;
        }
      },
    }),
  };
}

function discoverReplaySourcePaths(params: {
  inputs: string[];
  cwd: string;
  replayBackend?: string;
}): string[] {
  const extensions =
    params.replayBackend === 'maestro' ? new Set(['.yaml', '.yml', '.ad']) : new Set(['.ad']);
  const paths: string[] = [];
  for (const input of params.inputs) {
    const resolved = resolveUserPath(input, { cwd: params.cwd });
    if (!fs.existsSync(resolved)) {
      throw new Error(`test input not found: ${input}`);
    }
    if (fs.statSync(resolved).isDirectory()) {
      paths.push(...listReplayFiles(resolved, extensions));
    } else if (extensions.has(path.extname(resolved).toLowerCase())) {
      paths.push(path.normalize(resolved));
    } else {
      throw new Error(`test does not support this file type: ${input}`);
    }
  }
  return [...new Set(paths)];
}

function listReplayFiles(directory: string, extensions: ReadonlySet<string>): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listReplayFiles(filePath, extensions));
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
      found.push(filePath);
  }
  return found;
}
