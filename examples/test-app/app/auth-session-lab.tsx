import { useRouter } from 'expo-router';

import { AppFrame } from '../src/components';
import { AuthSessionLabScreen } from '../src/screens/AuthSessionLabScreen';

export default function AuthSessionLabRoute() {
  const router = useRouter();

  return (
    <AppFrame>
      <AuthSessionLabScreen onBack={() => router.back()} />
    </AppFrame>
  );
}
