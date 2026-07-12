export type MaestroExportConfig = {
  appId?: string;
  env?: Record<string, string>;
};

export type MaestroExportCommand = string | Record<string, unknown>;
