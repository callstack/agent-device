export type PushCommandResult =
  | {
      platform: 'ios';
      bundleId: string;
      message: string;
    }
  | {
      platform: 'android';
      package: string;
      action: string;
      extrasCount: number;
      message: string;
    };
