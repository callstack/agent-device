export type ProviderConnectionResource = {
  status: 'verified' | 'configured' | 'deferred' | 'missing';
  name?: string;
  reference?: string;
  platform?: 'android' | 'ios';
  osVersion?: string;
  version?: string;
  availability?: string;
  message?: string;
};

export type ProviderConnectionVerification = {
  provider: string;
  service: string;
  verificationMessage: string;
  project?: { name?: string; reference: string };
  device: ProviderConnectionResource;
  app: ProviderConnectionResource;
};

export type ConnectionProviderCapabilities = {
  leaseKind: 'proxy' | 'direct-device-provider' | 'remote-provider';
  requiresAppAttachment: boolean;
  requiresRemoteDaemon: boolean;
  supportsArtifacts: boolean;
  supportsDeferredAppSelection: boolean;
  supportsDirectPortReverse: boolean;
  usesCloudWebDriverLease: boolean;
  /**
   * The provider leases a cloud-hosted device that bills while held. A lease with this capability or
   * `usesCloudWebDriverLease` requests the cloud device lease TTL on each lease-using command.
   */
  holdsCloudDevice?: boolean;
};
