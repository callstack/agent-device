export type DoublespeedHostAdapter = {
  archiveDirectory(options: {
    sourceDirectory: string;
    entryName: string;
    archivePath: string;
  }): Promise<void>;
};

export type DoublespeedIosRuntimeAdapter = {
  resolveAppAlias(app: string): Promise<string>;
  readBundleAppName(appPath: string): Promise<string | undefined>;
};

export type DoublespeedRuntimeDependencies = {
  clientVersion: string;
  host: DoublespeedHostAdapter;
  ios: DoublespeedIosRuntimeAdapter;
};
