import type { Interactor } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import { stripAtPrefix } from '../interaction-positionals.ts';
import { withDiagnosticTimer } from '../../utils/diagnostics.ts';
import { resolveWebProvider, type WebProvider } from '../../platforms/web/provider.ts';
import { createUnsupportedInteractor } from '../../platforms/unsupported-interactor.ts';

export function createWebInteractor(provider: WebProvider = resolveWebProvider()): Interactor {
  const clickRef = provider.clickRef;
  const hover = provider.hover;
  const hoverRef = provider.hoverRef;
  const fillRef = provider.fillRef;
  return {
    ...createUnsupportedInteractor('web'),
    open: (target, options) => provider.open(options?.url ?? target, { url: options?.url }),
    openDevice: () => provider.open('about:blank'),
    close: (target) => provider.close(target),
    tap: (x, y) => provider.click(x, y),
    ...(clickRef
      ? {
          tapRef: async (ref: string) => {
            await clickRef(ref);
            return { ref: stripAtPrefix(ref) };
          },
        }
      : {}),
    ...(hover ? { hover: async (x: number, y: number) => await hover(x, y) } : {}),
    ...(hoverRef
      ? {
          hoverRef: async (ref: string) => {
            await hoverRef(ref);
            return { ref: stripAtPrefix(ref) };
          },
        }
      : {}),
    focus: (x, y) => provider.click(x, y),
    type: (text, delayMs) => provider.typeText(text, { delayMs }),
    fill: (x, y, text, delayMs) => provider.fill(x, y, text, { delayMs }),
    ...(fillRef
      ? {
          fillRef: async (ref: string, text: string, delayMs?: number) => {
            await fillRef(ref, text, { delayMs });
            return { ref: stripAtPrefix(ref), text, delayMs: delayMs ?? 0 };
          },
        }
      : {}),
    scroll: (direction, options) => provider.scroll(direction, options),
    screenshot: (outPath, options) => provider.screenshot(outPath, options),
    setViewport: (width, height) => provider.setViewport(width, height),
    snapshot: async (options) => {
      const result = await withDiagnosticTimer(
        'snapshot_capture',
        async () => await provider.snapshot(options),
        { backend: 'web' },
      );
      return {
        nodes: result.nodes,
        truncated: result.truncated ?? false,
        backend: 'web',
        producer: 'agent-browser',
      };
    },
    setOrientation: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'orientation is not supported on web');
    },
  };
}
