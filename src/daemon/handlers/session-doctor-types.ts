export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'info';

export type DoctorKind = 'auto' | 'react-native' | 'expo' | 'repack';

export type DoctorOptions = {
  targetApp?: string;
  metroHost: string;
  metroPort: number;
  kind: DoctorKind;
  shouldProbeMetro: boolean;
  remote: boolean;
};

export type DoctorCheck = {
  id: string;
  status: DoctorStatus;
  summary: string;
  hint?: string;
  command?: string;
  evidence?: Record<string, unknown>;
};
