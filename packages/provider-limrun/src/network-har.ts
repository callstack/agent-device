import { DestinationTunnelHARAssembler } from '@limrun/api/destination-tunnel-har';
import { validateDestinationTunnelSelectors } from '@limrun/api/destination-tunnel';
import type { DestinationTunnelHAREntry } from '@limrun/api/destination-tunnel-har';
import type { DestinationTunnelInspectionEvent } from '@limrun/api/destination-tunnel-inspection';
import type { DestinationTcpTunnel } from '@limrun/api/destination-tunnel-dialer';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The prototype Limrun network capture: one destination tunnel with inspection, streamed into a
 * live HAR 1.2 file. The file is rewritten on every completed request, so a reader (jq included)
 * always sees a valid document, during the session and after it.
 *
 * One instance carries one destination tunnel, so the Metro/companion route rides this same
 * tunnel: the default selectors include the `localhost:8081` route, which makes the host's Metro
 * reachable from the device through the tunnel.
 *
 * Known limits: certificate-pinned hosts fail closed against the tunnel's interception, and apps
 * that resolve names over DNS-over-HTTPS bypass the capture entirely.
 */

/** Generic public-TLD wildcards, measured acceptable by Limrun's selector validation. */
export const DEFAULT_LIMRUN_HAR_SELECTORS = Object.freeze([
  '*.com',
  '*.org',
  '*.app',
  '*.net',
  '*.io',
  '*.dev',
  // The Metro/companion route: the device reaches this host's Metro through the one tunnel.
  'localhost:8081',
] as const);

export type LimrunHarTunnelClient = Readonly<{
  startTunnel(options: {
    selectors: string[];
    inspection?: { enabled?: boolean; captureBodies?: boolean };
    onInspectionEvent?: (event: DestinationTunnelInspectionEvent) => void;
    onInspectionError?: (error: Error) => void;
  }): Promise<DestinationTcpTunnel>;
}>;

export type LimrunHarCapture = Readonly<{
  harPath: string;
  /** Stops inspection and writes the final HAR document. Safe more than once. */
  close(): void;
}>;

export type LimrunHarCaptureFailure = Readonly<{
  reason: 'tunnel-in-use' | 'tunnel-start-failed';
  message: string;
}>;

export type LimrunHarCaptureResult =
  | Readonly<{ ok: true; capture: LimrunHarCapture }>
  | Readonly<{ ok: false } & LimrunHarCaptureFailure>;

/**
 * Opens the instance's destination tunnel with inspection and writes every completed request into
 * `harPath` as a HAR 1.2 document. Bodies are captured; the file holds raw traffic.
 */
export async function startLimrunHarCapture(
  client: LimrunHarTunnelClient,
  input: Readonly<{ harPath: string; selectors?: readonly string[] }>,
): Promise<LimrunHarCaptureResult> {
  const selectors = [...(input.selectors ?? DEFAULT_LIMRUN_HAR_SELECTORS)];
  try {
    validateDestinationTunnelSelectors(selectors);
  } catch (error) {
    return { ok: false, reason: 'tunnel-start-failed', message: describe(error) };
  }
  const entries: DestinationTunnelHAREntry[] = [];
  try {
    fs.mkdirSync(path.dirname(input.harPath), { recursive: true });
    writeHar(input.harPath, entries);
    const assembler = new DestinationTunnelHARAssembler();
    const tunnel = await client.startTunnel({
      selectors,
      inspection: { enabled: true, captureBodies: true },
      onInspectionEvent: (event) => {
        const completed = assembler.add(event);
        if (!completed || event.type !== 'complete') return;
        entries.push(completed);
        writeHar(input.harPath, entries);
      },
    });
    let closed = false;
    return {
      ok: true,
      capture: Object.freeze({
        harPath: input.harPath,
        close: () => {
          if (closed) return;
          closed = true;
          tunnel.close();
          writeHar(input.harPath, entries);
        },
      }),
    };
  } catch (error) {
    const message = describe(error);
    return {
      ok: false,
      reason: /already_active/i.test(message) ? 'tunnel-in-use' : 'tunnel-start-failed',
      message,
    };
  }
}

function writeHar(harPath: string, entries: readonly DestinationTunnelHAREntry[]): void {
  const document = {
    log: {
      version: '1.2',
      creator: { name: 'agent-device limrun-tunnel', version: '1' },
      entries,
    },
  };
  // Write-then-rename, so a reader never observes a half-written document.
  const tempPath = `${harPath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 1)}\n`);
  fs.renameSync(tempPath, harPath);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
