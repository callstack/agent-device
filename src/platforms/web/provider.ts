import type { ScrollDirection } from '../../contracts/scroll-gesture.ts';
import type { SessionSurface } from '../../contracts/session-surface.ts';
import { createScopedProvider } from '../../utils/scoped-provider.ts';
import type { RawSnapshotNode } from '../../kernel/snapshot.ts';
import type { BackendDumpNetworkOptions, BackendDumpNetworkResult } from '../../backend.ts';
import type { AudioProbeResult } from '../../audio-probe-result.ts';
import { createAgentBrowserWebProvider } from './agent-browser-provider.ts';

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
  includeRects?: boolean;
  surface?: SessionSurface;
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

const localWebProvider: WebProvider = createAgentBrowserWebProvider();

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
