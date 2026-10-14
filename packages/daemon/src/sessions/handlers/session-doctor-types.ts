import type { DoctorKind } from '@agent-device/contracts/observability';

export type DoctorOptions = {
  targetApp?: string;
  metroHost: string;
  metroPort: number;
  kind: DoctorKind;
  shouldProbeMetro: boolean;
  remote: boolean;
};
