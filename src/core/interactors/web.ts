import type { Interactor } from '../../contracts/interactor-types.ts';
import { AppError } from '@agent-device/kernel/errors';
import { withDiagnosticTimer } from '../../utils/diagnostics.ts';
import { resolveWebProvider } from '../../platforms/web/provider.ts';
import { createUnsupportedInteractor } from '../../platforms/unsupported-interactor.ts';

export function createWebInteractor(): Interactor {
  const provider = () => resolveWebProvider();
  return {
    ...createUnsupportedInteractor('web'),
    open: (target, options) => provider().open(options?.url ?? target, { url: options?.url }),
    openDevice: () => provider().open('about:blank'),
    close: (target) => provider().close(target),
    tap: (x, y) => provider().click(x, y),
    focus: (x, y) => provider().click(x, y),
    type: (text, delayMs) => provider().typeText(text, { delayMs }),
    fill: (x, y, text, delayMs) => provider().fill(x, y, text, { delayMs }),
    scroll: (direction, options) => provider().scroll(direction, options),
    screenshot: (outPath, options) => provider().screenshot(outPath, options),
    setViewport: (width, height) => provider().setViewport(width, height),
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
    setOrientation: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'orientation is not supported on web');
    },
  };
}
