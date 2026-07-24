import { useRouter } from 'expo-router';

import { WebViewScreen } from '../src/screens/WebViewScreen';

export default function WebViewRoute() {
  const router = useRouter();

  return <WebViewScreen onClose={() => router.back()} />;
}
