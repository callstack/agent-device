import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentDeviceBackend } from '../backend.ts';
import type { ArtifactAdapter } from '../io.ts';
import { createAgentDevice, localCommandPolicy } from '../runtime.ts';
import { dispatchCommand } from '../core/dispatch.ts';
import { screenshotFlagsFromOptions, screenshotOptionsFromFlags } from '../contracts/screenshot.ts';
import { AppError } from '../kernel/errors.ts';
import { readScreenshotResultData } from '../utils/screenshot-result.ts';
import type { DaemonCommandContext } from './context.ts';
import type { SessionState } from './types.ts';
import { createDaemonRuntimeSessionStore } from './runtime-session.ts';

export type ScreenshotOutputPlacement = 'positional' | 'out' | 'default';

export async function dispatchScreenshotViaRuntime(params: {
  session: SessionState;
  sessionName: string;
  outPath?: string;
  outputPlacement: ScreenshotOutputPlacement;
  dispatchContext: DaemonCommandContext;
}): Promise<Record<string, unknown>> {
  const { session, sessionName, outPath, outputPlacement, dispatchContext } = params;
  const runtime = createAgentDevice({
    backend: createDispatchScreenshotBackend({ session, outputPlacement, dispatchContext }),
    artifacts: createDaemonScreenshotArtifactAdapter(),
    sessions: createDaemonRuntimeSessionStore({
      sessionName,
      getSession: () => session,
      recordOptions: { includeSnapshot: false },
      setRecord: () => {},
    }),
    policy: localCommandPolicy(),
  });

  return await runtime.capture.screenshot({
    session: sessionName,
    requestId: dispatchContext.requestId,
    appBundleId: session.appBundleId,
    ...screenshotOptionsFromFlags(dispatchContext),
    surface: session.surface,
    ...(outPath ? { out: { kind: 'path', path: outPath } } : {}),
  });
}

function createDispatchScreenshotBackend(params: {
  session: SessionState;
  outputPlacement: ScreenshotOutputPlacement;
  dispatchContext: DaemonCommandContext;
}): AgentDeviceBackend {
  const { session, outputPlacement, dispatchContext } = params;
  return {
    platform: session.device.platform,
    captureScreenshot: async (_context, outPath, options) => {
      const context = {
        ...dispatchContext,
        ...screenshotFlagsFromOptions(options),
        surface: options?.surface,
        skipIosSimulatorBootCheck:
          dispatchContext.skipIosSimulatorBootCheck ??
          (session.device.platform === 'ios' && session.device.kind === 'simulator'),
      };
      if (outputPlacement === 'out') {
        return readScreenshotResultData(
          await dispatchCommand(session.device, 'screenshot', [], outPath, context),
        );
      }
      return readScreenshotResultData(
        await dispatchCommand(session.device, 'screenshot', [outPath], undefined, context),
      );
    },
  };
}

function createDaemonScreenshotArtifactAdapter(): ArtifactAdapter {
  return {
    resolveInput: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'screenshot does not resolve input artifacts');
    },
    reserveOutput: async (ref) => {
      let tempRoot: string | undefined;
      let outputPath: string;
      if (ref?.kind === 'path') {
        outputPath = ref.path;
      } else {
        tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-screenshot-'));
        outputPath = path.join(tempRoot, 'screenshot.png');
      }
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      return {
        path: outputPath,
        visibility: 'client-visible',
        publish: async () => undefined,
        ...(tempRoot
          ? {
              cleanup: async () => {
                await fs.rm(tempRoot, { recursive: true, force: true });
              },
            }
          : {}),
      };
    },
    createTempFile: async (options) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `${options.prefix}-`));
      return {
        path: path.join(root, `file${options.ext}`),
        visibility: 'internal',
        cleanup: async () => {
          await fs.rm(root, { recursive: true, force: true });
        },
      };
    },
  };
}
