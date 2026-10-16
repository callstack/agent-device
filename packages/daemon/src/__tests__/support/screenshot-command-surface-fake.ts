import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import { resizePngFileToScale } from '@agent-device/capture-kit/png-resize';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import fs from 'node:fs/promises';
import path from 'node:path';
import { forwardingCreateCommandSurfaceWithAnnotations } from './command-surface-fake.ts';

export const screenshotCommandSurface: CreateDaemonCommandSurface = async (config) => {
  const forwarded = await forwardingCreateCommandSurfaceWithAnnotations(config);
  return {
    ...forwarded,
    capture: {
      ...forwarded.capture,
      screenshot: async (options) => {
        const tempDir =
          options.out?.kind === 'path' ? undefined : mkdtempForTestSync('agent-device-screenshot-');
        const outputPath =
          options.out?.kind === 'path' ? options.out.path : path.join(tempDir!, 'screenshot.png');
        try {
          const captured = await config.backend.captureScreenshot?.(
            {
              session: options.session ?? 'default',
              requestId: options.requestId,
              appBundleId: options.appBundleId,
              signal: options.signal ?? config.signal,
            },
            outputPath,
            {
              fullscreen: options.fullscreen,
              overlayRefs: options.overlayRefs,
              pixelDensity: options.pixelDensity,
              stabilize: options.stabilize,
              normalizeStatusBar: options.normalizeStatusBar,
              surface: options.surface,
            },
          );
          if (options.scale !== undefined) await resizePngFileToScale(outputPath, options.scale);
          return {
            path: outputPath,
            ...(captured?.displayRotation ? { displayRotation: captured.displayRotation } : {}),
          };
        } catch (error) {
          if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
          throw error;
        }
      },
    },
  };
};
