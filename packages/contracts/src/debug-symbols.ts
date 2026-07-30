export type DebugSymbolsOptions = {
  action?: 'symbols';
  artifact: string;
  dsym?: string;
  searchPath?: string;
  out?: string;
  cwd?: string;
};

export type DebugSymbolsImage = {
  name: string;
  uuid: string;
  arch?: string;
  dsymPath: string;
  binaryPath: string;
};

export type DebugSymbolsCrashFrame = {
  index: number;
  image: string;
  address: string;
  symbol?: string;
};

export type DebugSymbolsCrashSummary = {
  format: 'ips' | 'text';
  appName?: string;
  bundleId?: string;
  version?: string;
  incident?: string;
  timestamp?: string;
  exceptionType?: string;
  exceptionCodes?: string;
  terminationReason?: string;
  crashedThread?: number;
  topFrames: DebugSymbolsCrashFrame[];
  findings: string[];
};

export type DebugSymbolsResult = {
  kind: 'debugSymbols';
  platform: 'apple';
  artifactPath: string;
  outPath: string;
  crash: DebugSymbolsCrashSummary;
  matchedImages: DebugSymbolsImage[];
  symbolicatedFrames: number;
  skippedImages: number;
  warnings?: string[];
  message: string;
};
