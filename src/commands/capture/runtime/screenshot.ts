import { AppError } from '@agent-device/kernel/errors';
import { validateScreenshotScale } from '@agent-device/contracts/capture';
import { successText } from '@agent-device/kernel/success-text';
import { resizePngFileToScale } from '@agent-device/capture-kit/png-resize';
import type { ArtifactDescriptor } from '../../../io.ts';
import type { RuntimeCommand, ScreenshotCommandOptions } from '../../runtime-types.ts';
import { reserveCommandOutput } from '../../io-policy.ts';

export type ScreenshotCommandResult = {
  path: string;
  artifacts?: ArtifactDescriptor[];
  message?: string;
};

export const screenshotCommand: RuntimeCommand<
  ScreenshotCommandOptions,
  ScreenshotCommandResult
> = async (runtime, options): Promise<ScreenshotCommandResult> => {
  if (!runtime.backend.captureScreenshot) {
    throw new AppError('UNSUPPORTED_OPERATION', 'screenshot is not supported by this backend');
  }
  validateScreenshotScale(options);

  const reserved = await reserveCommandOutput(runtime, options.out, {
    field: 'path',
    ext: '.png',
    artifactType: 'screenshot',
  });

  let artifact: ArtifactDescriptor | undefined;
  try {
    await runtime.backend.captureScreenshot(
      {
        session: options.session,
        requestId: options.requestId,
        appId: options.appId,
        appBundleId: options.appBundleId,
        signal: options.signal ?? runtime.signal,
        metadata: options.metadata,
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
    if (options.scale !== undefined) {
      await resizePngFileToScale(reserved.path, options.scale);
    }
    artifact = await reserved.publish();
  } catch (error) {
    await reserved.cleanup?.();
    throw error;
  }

  return {
    path: reserved.path,
    ...(artifact ? { artifacts: [artifact] } : {}),
    ...successText(`Saved screenshot: ${reserved.path}`),
  };
};
