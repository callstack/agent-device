import { defineRuntimeSlots } from '@agent-device/host-kit/runtime-slots';

/**
 * What one daemon runtime owns of the Android helper. The root keeps the store and binds its slot
 * accessor into the adb host port, so the Android package declares only its slot keys and a close
 * tears down only the runtime that closes. Kept apart from the adb host binding so daemon
 * composition can register the state without loading the Android mechanics.
 */
const androidHelperRuntime = defineRuntimeSlots();

export const createAndroidHelperRuntimeState = androidHelperRuntime.createHandle;
export const androidHelperRuntimeSlot = androidHelperRuntime.slot;
