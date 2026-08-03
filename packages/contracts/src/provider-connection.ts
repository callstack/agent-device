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
