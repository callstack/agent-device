import type { DeviceInfo, PublicPlatform } from '@agent-device/kernel/device';

export type WearablePairingEndpoint = Readonly<{
  platform: Extract<PublicPlatform, 'ios' | 'android'>;
  deviceId: string;
}>;

export type WearableSelector = Readonly<
  | { deviceId: string; name?: string }
  | { deviceId?: string; name: string }
>;

export type PairWearableInput = Readonly<{
  wearable?: WearableSelector;
  boot: boolean;
}>;

export type WearablePairingStatus = 'connected' | 'paired' | 'human-step-required';

export type WearablePairingRuntimeResult = Readonly<{
  pairId: string;
  phone: DeviceInfo;
  wearable: DeviceInfo;
  status: WearablePairingStatus;
  remainingHumanStep?: string;
}>;

export type WearablePairingRuntimeOperations = Readonly<{
  pairWearable(input: PairWearableInput): Promise<WearablePairingRuntimeResult>;
}>;
