import type { DoctorKind } from '../../contracts/doctor.ts';

export type { DoctorCheck, DoctorKind, DoctorStatus } from '../../contracts/doctor.ts';

export type DoctorOptions = {
  targetApp?: string;
  metroHost: string;
  metroPort: number;
  kind: DoctorKind;
  shouldProbeMetro: boolean;
  remote: boolean;
};
