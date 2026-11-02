type ConnectionFlags = Readonly<{ flags: Readonly<{ device?: string }> }>;

/** Plugin `connection` for a TV whose device is read from vendor tooling when a session opens. */
export function tvPluginConnection(options: {
  provider: string;
  service: string;
  verificationMessage: string;
  defaultDevice?: string;
}) {
  const { provider, service, verificationMessage, defaultDevice } = options;
  return {
    capabilities: {
      leaseKind: 'direct-device-provider',
      requiresAppAttachment: false,
      requiresRemoteDaemon: false,
      supportsArtifacts: false,
      supportsDeferredAppSelection: true,
      supportsDirectPortReverse: false,
      usesCloudWebDriverLease: false,
    },
    resolve: ({ flags }: ConnectionFlags) => ({
      profile: {
        leaseProvider: provider,
        platform: 'android' as const,
        target: 'tv' as const,
        ...(flags.device ? { device: flags.device } : {}),
      },
    }),
    verify: async ({ flags }: ConnectionFlags) => {
      const device = flags.device ?? defaultDevice;
      return {
        provider,
        service,
        verificationMessage,
        device: { status: 'deferred' as const, ...(device ? { name: device } : {}) },
        app: { status: 'deferred' as const },
      };
    },
  } as const;
}
