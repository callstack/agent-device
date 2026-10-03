export type MaestroExportConfig = {
  appId?: string;
  env?: Record<string, string>;
};

export type MaestroExportCommand = string | Record<string, unknown>;

export type ConvertedAction =
  | { kind: 'commands'; commands: MaestroExportCommand[]; warnings?: string[] }
  | { kind: 'config'; appId: string; commands: MaestroExportCommand[]; warnings?: string[] }
  | { kind: 'unsupported'; message: string };
