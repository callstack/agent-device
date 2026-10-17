import type { CreateDaemonCommandSurface } from '@agent-device/contracts/daemon-command-surface';
import { forwardingCreateCommandSurfaceWithAnnotations } from './command-surface-fake.ts';

export const screenshotCommandSurface: CreateDaemonCommandSurface = async (config) => {
  const forwarded = await forwardingCreateCommandSurfaceWithAnnotations(config);
  return {
    ...forwarded,
    capture: {
      ...forwarded.capture,
      screenshot: async (options) => {
        const reserved = await config.artifacts.reserveOutput(options.out, {
          field: 'path',
          ext: '.png',
          artifactType: 'screenshot',
        });
        try {
          const captured = await config.backend.captureScreenshot?.(
            {
              session: options.session ?? 'default',
              requestId: options.requestId,
              appBundleId: options.appBundleId,
              signal: options.signal ?? config.signal,
            },
            reserved.path,
            {
              fullscreen: options.fullscreen,
              overlayRefs: options.overlayRefs,
              pixelDensity: options.pixelDensity,
              stabilize: options.stabilize,
              normalizeStatusBar: options.normalizeStatusBar,
              surface: options.surface,
            },
          );
          return {
            path: reserved.path,
            ...(captured?.displayRotation ? { displayRotation: captured.displayRotation } : {}),
          };
        } catch (error) {
          await reserved.cleanup?.();
          throw error;
        }
      },
    },
  };
};
