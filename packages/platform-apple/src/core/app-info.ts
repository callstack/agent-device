export type IosAppInfo = {
  bundleId: string;
  name: string;
  url?: string;
};

export type IosDeviceProcessInfo = {
  executable: string;
  pid: number;
};

export type IosDeviceAppProcesses = {
  appBundleUrl: string;
  processes: IosDeviceProcessInfo[];
};
