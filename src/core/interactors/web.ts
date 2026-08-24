import type { Interactor } from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import { stripAtPrefix } from '../interaction-positionals.ts';
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
    tapRef: async (ref) => {
      const clickRef = provider().clickRef;
      if (!clickRef) throw new AppError('UNSUPPORTED_OPERATION', 'web ref click is unavailable');
      await clickRef(ref);
      return { ref: stripAtPrefix(ref) };
    },
    hover: async (x, y) => {
      const hover = provider().hover;
      if (!hover) {
        throw new AppError('UNSUPPORTED_OPERATION', 'hover is not supported by this web provider');
      }
      await hover(x, y);
    },
    hoverRef: async (ref) => {
      const hoverRef = provider().hoverRef;
      if (!hoverRef) throw new AppError('UNSUPPORTED_OPERATION', 'web ref hover is unavailable');
      await hoverRef(ref);
      return { ref: stripAtPrefix(ref) };
    },
    focus: (x, y) => provider().click(x, y),
    type: (text, delayMs) => provider().typeText(text, { delayMs }),
    fill: (x, y, text, delayMs) => provider().fill(x, y, text, { delayMs }),
    fillRef: async (ref, text, delayMs) => {
      const fillRef = provider().fillRef;
      if (!fillRef) throw new AppError('UNSUPPORTED_OPERATION', 'web ref fill is unavailable');
      await fillRef(ref, text, { delayMs });
      return { ref: stripAtPrefix(ref), text, delayMs: delayMs ?? 0 };
    },
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
