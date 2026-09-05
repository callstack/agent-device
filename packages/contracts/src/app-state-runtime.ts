/** Neutral foreground identity returned by a selected platform/provider runtime. */
export type AppStateRuntimeResult = Readonly<{
  package?: string;
  activity?: string;
}>;

export type AppStateRuntimeOperations = Readonly<{
  appState(): Promise<AppStateRuntimeResult>;
}>;
