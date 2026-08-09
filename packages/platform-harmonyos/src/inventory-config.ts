export type HarmonyInventoryConfig = Readonly<{
  /** Raw HDC_SDK_PATH captured inertly by the composition root. */
  hdcSdkPath?: string;
  /** Raw DEVECO_SDK_HOME captured inertly by the composition root. */
  devecoSdkHome?: string;
  /** Raw HARMONYOS_COMMAND_LINE_TOOLS captured inertly by the composition root. */
  commandLineToolsHome?: string;
}>;
