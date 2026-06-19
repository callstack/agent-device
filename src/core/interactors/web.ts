import type { Interactor } from '../interactor-types.ts';
import { AppError } from '../../utils/errors.ts';
import { withDiagnosticTimer } from '../../utils/diagnostics.ts';
import { resolveWebProvider } from '../../platforms/web/provider.ts';

export function createWebInteractor(): Interactor {
  const provider = () => resolveWebProvider();
  return {
    open: (target, options) => provider().open(options?.url ?? target, { url: options?.url }),
    openDevice: () => provider().open('about:blank'),
    close: (target) => provider().close(target),
    tap: (x, y) => provider().click(x, y),
    doubleTap: () => unsupportedWebOperation('doubleTap'),
    swipe: () => unsupportedWebOperation('swipe'),
    pan: () => unsupportedWebOperation('pan'),
    fling: () => unsupportedWebOperation('fling'),
    longPress: () => unsupportedWebOperation('longPress'),
    focus: (x, y) => provider().click(x, y),
    type: (text, delayMs) => provider().typeText(text, { delayMs }),
    fill: (x, y, text, delayMs) => provider().fill(x, y, text, { delayMs }),
    scroll: (direction, options) => provider().scroll(direction, options),
    pinch: () => unsupportedWebOperation('pinch'),
    screenshot: (outPath, options) => provider().screenshot(outPath, options),
    snapshot: async (options) => {
      const result = await withDiagnosticTimer(
        'snapshot_capture',
        async () => await provider().snapshot(options),
        { backend: 'web' },
      );
      return {
        nodes: result.nodes,
        truncated: result.truncated ?? false,
        backend: 'web',
      };
    },
    back: () => unsupportedWebOperation('back'),
    home: () => unsupportedWebOperation('home'),
    rotate: () => unsupportedWebOperation('rotate'),
    rotateGesture: () => unsupportedWebOperation('rotateGesture'),
    transformGesture: () => unsupportedWebOperation('transformGesture'),
    appSwitcher: () => unsupportedWebOperation('appSwitcher'),
    readClipboard: () => unsupportedWebOperation('readClipboard'),
    writeClipboard: () => unsupportedWebOperation('writeClipboard'),
    setSetting: () => unsupportedWebOperation('setSetting'),
  };
}

async function unsupportedWebOperation(operation: string): Promise<never> {
  throw new AppError('UNSUPPORTED_OPERATION', `${operation} is not supported on web`);
}
