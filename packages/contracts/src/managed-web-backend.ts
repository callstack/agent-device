/** Deadline that web session teardown must leave for the managed browser. */
export const AGENT_BROWSER_TIMEOUT_MS = 30_000;

export type ManagedWebBackendStatus = Readonly<{
  version: string;
  stateDir: string;
  installDir: string;
  packageDir: string;
  /** npm's console shim. Informational only; callers never spawn it. */
  binaryPath: string;
  /** Backend JavaScript entry, undefined until the managed package is installed. */
  entryScript: string | undefined;
  homeDir: string;
  runtimeHomeDir: string;
  socketDir: string;
  installed: boolean;
  nodeMajor: number;
  nodeSupported: boolean;
}>;

export type ManagedWebBackendDoctorResult = Readonly<{
  status: ManagedWebBackendStatus;
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/** The complete host-tool surface owned by `agent-device web setup|doctor`. */
export type ManagedWebBackend = Readonly<{
  setup(options: { stateDir?: string }): Promise<ManagedWebBackendStatus>;
  doctor(options: { stateDir?: string }): Promise<ManagedWebBackendDoctorResult>;
}>;
