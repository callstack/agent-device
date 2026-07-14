import { useRouter } from 'expo-router';

import { AppFrame } from '../src/components';
import { AccessorySetupScreen } from '../src/screens/AccessorySetupScreen';

export default function AccessorySetupRoute() {
  const router = useRouter();

  return (
    <AppFrame>
      <AccessorySetupScreen onBack={() => router.back()} />
    </AppFrame>
  );
}
