import type { DeviceTarget, PlatformSelector } from '../kernel/device.ts';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'info';

export type DoctorKind = 'auto' | 'react-native' | 'expo' | 'repack';

export type DoctorCheck = {
  id: string;
  status: DoctorStatus;
  summary: string;
  hint?: string;
  command?: string;
  evidence?: Record<string, unknown>;
};

export type DoctorCommandResult = {
  status: DoctorStatus;
  summary: string;
  kind: DoctorKind;
  platform?: PlatformSelector;
  target?: DeviceTarget;
  targetApp?: string;
  metro?: {
    host: string;
    port: number;
  };
  checks: DoctorCheck[];
};
