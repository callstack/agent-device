import type { Interactor } from '@agent-device/contracts/interactor-types';
import { AppError } from '@agent-device/kernel/errors';
import { stripAtPrefix } from '../interaction-positionals.ts';
import { withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { resolveWebProvider, type WebProvider } from '@agent-device/platform-web';
import { createUnsupportedInteractor } from './unsupported-interactor.ts';

export async function createWebInteractor(provider?: WebProvider): Promise<Interactor> {
  const resolvedProvider = provider ?? (await resolveWebProvider());
  const clickRef = resolvedProvider.clickRef;
  const hover = resolvedProvider.hover;
  const hoverRef = resolvedProvider.hoverRef;
  const fillRef = resolvedProvider.fillRef;
  return {
    ...createUnsupportedInteractor('web'),
    open: (target, options) => resolvedProvider.open(options?.url ?? target, { url: options?.url }),
    openDevice: () => resolvedProvider.open('about:blank'),
    close: (target) => resolvedProvider.close(target),
    tap: (x, y) => resolvedProvider.click(x, y),
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
    focus: (x, y) => resolvedProvider.click(x, y),
    type: (text, delayMs) => resolvedProvider.typeText(text, { delayMs }),
    fill: (x, y, text, delayMs) => resolvedProvider.fill(x, y, text, { delayMs }),
    ...(fillRef
      ? {
          fillRef: async (ref: string, text: string, delayMs?: number) => {
            await fillRef(ref, text, { delayMs });
            return { ref: stripAtPrefix(ref), text, delayMs: delayMs ?? 0 };
          },
        }
      : {}),
    scroll: (direction, options) => resolvedProvider.scroll(direction, options),
    screenshot: (outPath, options) => resolvedProvider.screenshot(outPath, options),
    setViewport: (width, height) => resolvedProvider.setViewport(width, height),
    snapshot: async (options) => {
      const result = await withDiagnosticTimer(
        'snapshot_capture',
        async () => await resolvedProvider.snapshot(options),
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
