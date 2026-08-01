export type HostCommandResult = {
  stdout: string;
};

export type RunHostCommand = (
  command: string,
  args: readonly string[],
) => Promise<HostCommandResult>;

export type ProviderWebDriverDependencies = {
  clientVersion: string;
  runHostCommand: RunHostCommand;
};
