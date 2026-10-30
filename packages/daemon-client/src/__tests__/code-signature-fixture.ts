import { computeDaemonCodeSignature } from '@agent-device/host-kit/code-signature';
import { resolveDaemonLaunchSpec } from '../daemon-launch-spec.ts';

/**
 * The code signature a daemon started from this checkout records, read through the same launch
 * spec the client uses to launch and sign its daemon, so a fixture daemon is reused.
 */
export function currentDaemonCodeSignature(): string {
  const spec = resolveDaemonLaunchSpec();
  return computeDaemonCodeSignature(spec.useSrc ? spec.srcPath : spec.distPath, spec.root);
}
