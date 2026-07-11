export type UpstreamArtifact = {
  path: string;
  role: string;
  sha256: string;
};

export type UpstreamPin = {
  project: string;
  version: string;
  tag: string;
  commit: string;
  sourceUrl: string;
  artifacts: UpstreamArtifact[];
};

export type UpstreamSource = {
  path: string;
  line: number;
};

export type RawCommand = {
  type: string;
  source?: UpstreamSource;
  commands?: RawCommand[];
  [key: string]: unknown;
};

export type RawCase = {
  id: string;
  flow: string;
  commands: RawCommand[];
};

export type RawFixture = {
  schemaVersion: 1;
  upstream: UpstreamPin;
  cases: RawCase[];
};

export type NormalizedSource = UpstreamSource;

export type NormalizedSelector = {
  id?: string;
  text?: string;
  index?: number;
  childOf?: NormalizedSelector;
  enabled?: boolean;
  selected?: boolean;
};

export type NormalizedAction =
  | {
      kind: 'launchApp';
      appId: string;
      stopApp: boolean;
      source: NormalizedSource;
    }
  | {
      kind: 'swipe';
      mode: 'relative' | 'absolute' | 'direction';
      start?: [number, number];
      end?: [number, number];
      direction?: string;
      durationMs: number;
      source: NormalizedSource;
    }
  | {
      kind: 'tapOn' | 'assertVisible' | 'assertNotVisible';
      selector: NormalizedSelector;
      timeoutMs?: number;
      source: NormalizedSource;
    };

export type NormalizedCase = {
  id: string;
  flow: string;
  expected: NormalizedAction[];
};

export type NormalizedFixture = {
  schemaVersion: 1;
  upstream: UpstreamPin;
  cases: NormalizedCase[];
};
