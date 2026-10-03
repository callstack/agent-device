import { createNetworkConditioner } from './proxy-conditioner.ts';
import { runFreshCliMeasurement, runPersistentMeasurement } from './proxy-client.ts';
import { startProxy } from './proxy-process.ts';
import type { Measurement, ProxyNetwork, ScreenFixture } from './types.ts';

export async function runProxyMeasurements(options: {
  repoRoot: string;
  stateDir: string;
  clientStateDir: string;
  derivedPath: string;
  udid: string;
  fixtures: ScreenFixture[];
  samples: number;
  rtts: readonly number[];
  bandwidthKbps: number | null;
  packetLossPercent: number;
  seed: number;
}): Promise<{ measurements: Measurement[]; networks: ProxyNetwork[] }> {
  const proxy = await startProxy(options.repoRoot, options.stateDir);
  const measurements: Measurement[] = [];
  const networks: ProxyNetwork[] = [];
  try {
    for (const rttMs of options.rtts) {
      const network: ProxyNetwork = {
        rttMs: rttMs as ProxyNetwork['rttMs'],
        bandwidthKbps: options.bandwidthKbps,
        packetLossPercent: options.packetLossPercent,
        seed: options.seed + rttMs,
      };
      networks.push(network);
      const conditioner = await createNetworkConditioner({
        upstreamBaseUrl: proxy.proxyBaseUrl,
        network,
      });
      try {
        for (const fixture of options.fixtures) {
          measurements.push(
            await runPersistentMeasurement({ ...options, proxy, conditioner, fixture, network }),
          );
          measurements.push(
            await runFreshCliMeasurement({ ...options, proxy, conditioner, fixture, network }),
          );
        }
      } finally {
        await conditioner.close();
      }
    }
    return { measurements, networks };
  } finally {
    await proxy.stop();
  }
}
