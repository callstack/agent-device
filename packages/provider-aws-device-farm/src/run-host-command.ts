/** What a plugin's `host.runHostCommand` answers: the command's standard output. */
export type HostCommandResult = Readonly<{ stdout: string }>;

/** The host-command capability a plugin calls; `ProviderPluginHost.runHostCommand` has this shape. */
export type RunHostCommand = (
  command: string,
  args: readonly string[],
) => Promise<HostCommandResult>;
