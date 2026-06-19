import type { ScrollDirection } from '../../core/scroll-gesture.ts';
import type { SessionSurface } from '../../core/session-surface.ts';
import { AppError } from '../../utils/errors.ts';
import { createScopedProvider } from '../../utils/scoped-provider.ts';
import type { RawSnapshotNode } from '../../utils/snapshot.ts';

export type WebOpenOptions = {
  url?: string;
};

export type WebScreenshotOptions = {
  fullscreen?: boolean;
  stabilize?: boolean;
  surface?: SessionSurface;
};

export type WebSnapshotOptions = {
  interactiveOnly?: boolean;
  depth?: number;
  scope?: string;
  raw?: boolean;
  surface?: SessionSurface;
};

export type WebSnapshotResult = {
  nodes: RawSnapshotNode[];
  truncated?: boolean;
};

export type WebProvider = {
  open(target: string, options?: WebOpenOptions): Promise<void>;
  close(target?: string): Promise<void>;
  snapshot(options?: WebSnapshotOptions): Promise<WebSnapshotResult>;
  screenshot(outPath: string, options?: WebScreenshotOptions): Promise<void>;
  click(x: number, y: number): Promise<void>;
  fill(x: number, y: number, text: string, options?: { delayMs?: number }): Promise<void>;
  typeText(text: string, options?: { delayMs?: number }): Promise<void>;
  scroll(direction: ScrollDirection, options?: { amount?: number; pixels?: number }): Promise<void>;
  readText?(x: number, y: number): Promise<string>;
};

const localWebProvider: WebProvider = {
  open: () => unsupportedLocalWebProvider(),
  close: () => unsupportedLocalWebProvider(),
  snapshot: () => unsupportedLocalWebProvider(),
  screenshot: () => unsupportedLocalWebProvider(),
  click: () => unsupportedLocalWebProvider(),
  fill: () => unsupportedLocalWebProvider(),
  typeText: () => unsupportedLocalWebProvider(),
  scroll: () => unsupportedLocalWebProvider(),
};

const webProviderScope = createScopedProvider(localWebProvider);

export function resolveWebProvider(provider?: WebProvider): WebProvider {
  return webProviderScope.resolve(provider);
}

export async function withWebProvider<T>(
  provider: WebProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await webProviderScope.run(provider, fn);
}

async function unsupportedLocalWebProvider(): Promise<never> {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'Web automation requires a request-scoped web provider.',
  );
}
