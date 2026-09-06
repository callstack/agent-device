import type { AudioProbeRuntimeHost } from '@agent-device/contracts/audio-probe-runtime-host';

/**
 * The audio probe host every platform runtime fixture shares: it identifies itself as a fixture,
 * owns no process, and refuses to start a capture. Shared here so no platform package carries its
 * own copy of a double that has nothing platform-specific in it.
 */
export function inertAudioProbeHost(): AudioProbeRuntimeHost {
  return {
    hostCapture: {
      info: {
        source: 'system-audio',
        backend: 'fixture',
        sourceCount: 0,
        notes: () => [],
      },
      start: async () => {
        throw new Error('Audio probe is outside this runtime fixture.');
      },
      inspectProcess: async () => 'missing',
      terminateProcess: async () => 'already-missing',
    },
    web: { resolve: async () => undefined },
    ownedProcesses: { replace: () => {}, clear: () => {} },
  };
}
