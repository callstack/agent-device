import type { ScreenshotResultData } from '@agent-device/contracts/capture';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { readPngSize } from './png-size.ts';

type ScreenshotDensityDevice = Pick<DeviceInfo, 'platform' | 'appleOs' | 'kind'>;

type ScreenshotPixelSize = {
  width: number;
  height: number;
};

const DEFAULT_SCREENSHOT_PIXEL_DENSITY = 1;

export function assertSupportedScreenshotPixelDensity(
  device: ScreenshotDensityDevice,
  pixelDensity: number | undefined,
  nativeDensity?: boolean,
): void {
  if (nativeDensity && pixelDensity !== undefined) {
    throw new AppError('INVALID_ARGS', 'Use either --pixel-density or --native-density');
  }
  if ((pixelDensity === undefined && !nativeDensity) || supportsScreenshotPixelDensity(device)) {
    return;
  }
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    '--pixel-density and --native-density are currently supported only on iOS-family simulators',
  );
}

export function computeDensityScaledScreenshotSize(
  size: ScreenshotPixelSize,
  sourcePixelDensity: number,
  requestedPixelDensity: number | undefined,
): ScreenshotPixelSize | undefined {
  const targetPixelDensity = resolveScreenshotPixelDensity(requestedPixelDensity);
  if (sourcePixelDensity === targetPixelDensity) return undefined;

  return {
    width: Math.max(1, Math.round((size.width / sourcePixelDensity) * targetPixelDensity)),
    height: Math.max(1, Math.round((size.height / sourcePixelDensity) * targetPixelDensity)),
  };
}

export async function readScreenshotResultMetadata(params: {
  device: ScreenshotDensityDevice;
  path: string;
  requestedPixelDensity: number | undefined;
  nativeDensity?: boolean;
  sourcePixelDensity?: number;
  scale: number | undefined;
}): Promise<ScreenshotResultData> {
  const requiresDensityMetadata = supportsScreenshotPixelDensity(params.device);
  let size: ScreenshotPixelSize;
  try {
    size = await readPngSize(params.path);
  } catch (error) {
    if (requiresDensityMetadata) throw error;
    return {};
  }
  const result: ScreenshotResultData = {
    width: size.width,
    height: size.height,
  };
  if (
    !requiresDensityMetadata ||
    (params.scale !== undefined && params.scale !== 1)
  ) {
    return result;
  }

  const pixelDensity = params.nativeDensity
    ? params.sourcePixelDensity
    : resolveScreenshotPixelDensity(params.requestedPixelDensity);
  if (pixelDensity === undefined) return result;
  return {
    ...result,
    logicalWidth: Math.round(size.width / pixelDensity),
    logicalHeight: Math.round(size.height / pixelDensity),
    pixelDensity,
  };
}

function resolveScreenshotPixelDensity(pixelDensity: number | undefined): number {
  return pixelDensity ?? DEFAULT_SCREENSHOT_PIXEL_DENSITY;
}

function supportsScreenshotPixelDensity(device: ScreenshotDensityDevice): boolean {
  return isIosFamily(device) && device.kind === 'simulator';
}
