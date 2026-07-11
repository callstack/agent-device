import { fileURLToPath } from 'node:url';

export const ANDROID_HELPER_FIXTURE_APK_PATH = fileURLToPath(
  new URL('./fixtures/helper-apk.fixture', import.meta.url),
);

export const ANDROID_HELPER_FIXTURE_APK_SHA256 =
  'a5f6a2fba1163bba2f13026bd3a192f52ba2816524b7cfa83c6b7ca568f6710a';
