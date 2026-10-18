import type { ScrollDirection } from '@agent-device/contracts/scroll-gesture';
import type { SessionSurface } from '@agent-device/contracts/session';
import { AppError } from '@agent-device/kernel/errors';
import { createScopedProvider } from '@agent-device/kernel/scoped-provider';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type {
  BackendDumpNetworkOptions,
  BackendDumpNetworkResult,
} from '@agent-device/contracts/backend-diagnostics';
import type { AudioProbeResult } from '@agent-device/contracts/audio-probe-result';

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
  includeRects?: boolean;
  surface?: SessionSurface;
  signal?: AbortSignal;
};

export type WebSnapshotResult = {
  nodes: RawSnapshotNode[];
  truncated?: boolean;
};

export type WebAudioProbeAction = 'start' | 'status' | 'stop';

export type WebAudioProbeOptions = {
  action: WebAudioProbeAction;
  durationMs?: number;
  bucketMs?: number;
};

export type WebAudioProbeResult = AudioProbeResult & {
  source: 'media-elements';
  mediaElementCount: number;
};

export type WebProvider = {
  open(target: string, options?: WebOpenOptions): Promise<void>;
  close(target?: string): Promise<void>;
  startRecording?(outPath: string): Promise<void>;
  stopRecording?(): Promise<void>;
  snapshot(options?: WebSnapshotOptions): Promise<WebSnapshotResult>;
  screenshot(outPath: string, options?: WebScreenshotOptions): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
  clickRef?(ref: string): Promise<void>;
  /** Move the pointer to a point without pressing, raising the page's hover state. */
  hover?(x: number, y: number): Promise<void>;
  /** Hover a snapshot ref through the provider's own element handle. */
  hoverRef?(ref: string): Promise<void>;
  fill(x: number, y: number, text: string, options?: { delayMs?: number }): Promise<void>;
  fillRef?(ref: string, text: string, options?: { delayMs?: number }): Promise<void>;
  typeText(text: string, options?: { delayMs?: number }): Promise<void>;
  scroll(
    direction: ScrollDirection,
    options?: { amount?: number; pixels?: number; durationMs?: number },
  ): Promise<Record<string, unknown> | void>;
  readText?(x: number, y: number): Promise<string>;
  dumpNetwork?(options?: BackendDumpNetworkOptions): Promise<BackendDumpNetworkResult>;
  probeAudio?(options: WebAudioProbeOptions): Promise<WebAudioProbeResult>;
};

/**
 * The un-composed fallback: a request that reaches a web device without a composed provider is a
 * composition bug, so it fails closed instead of borrowing a host it was never given (#3794).
 * Optional capabilities stay absent, exactly as a provider that lacks them reports them.
 */
function uncomposedWebProviderFailure(): Promise<never> {
  return Promise.reject(
    new AppError('COMMAND_FAILED', 'The web provider is not composed for this request.', {
      reason: 'web-provider-missing',
    }),
  );
}

const uncomposedWebProvider: WebProvider = {
  open: () => uncomposedWebProviderFailure(),
  close: () => uncomposedWebProviderFailure(),
  snapshot: () => uncomposedWebProviderFailure(),
  screenshot: () => uncomposedWebProviderFailure(),
  setViewport: () => uncomposedWebProviderFailure(),
  click: () => uncomposedWebProviderFailure(),
  fill: () => uncomposedWebProviderFailure(),
  typeText: () => uncomposedWebProviderFailure(),
  scroll: () => uncomposedWebProviderFailure(),
};

const webProviderScope = createScopedProvider(uncomposedWebProvider);

export function resolveWebProvider(provider?: WebProvider): WebProvider {
  return webProviderScope.resolve(provider);
}

/** True only for an explicitly request-scoped provider, never the local fallback. */
export function hasScopedWebProvider(): boolean {
  return webProviderScope.hasScope();
}

export async function withWebProvider<T>(
  provider: WebProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await webProviderScope.run(provider, fn);
}
