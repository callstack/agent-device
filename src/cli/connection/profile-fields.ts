import type { RemoteConfigMetroOptions } from '../../remote/remote-config-schema.ts';
import type { CliFlags } from '../parser/cli-flags.ts';

export function readMetroProfileFields(flags: CliFlags): RemoteConfigMetroOptions {
  return {
    metroProjectRoot: flags.metroProjectRoot,
    metroKind: flags.metroKind,
    metroPublicBaseUrl: flags.metroPublicBaseUrl,
    metroProxyBaseUrl: flags.metroProxyBaseUrl,
    metroPreparePort: flags.metroPreparePort,
    metroListenHost: flags.metroListenHost,
    metroStatusHost: flags.metroStatusHost,
    metroStartupTimeoutMs: flags.metroStartupTimeoutMs,
    metroProbeTimeoutMs: flags.metroProbeTimeoutMs,
    metroRuntimeFile: flags.metroRuntimeFile,
    metroNoReuseExisting: flags.metroNoReuseExisting,
    metroNoInstallDeps: flags.metroNoInstallDeps,
  };
}
