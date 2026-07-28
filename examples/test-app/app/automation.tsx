import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppFrame } from '../src/components';
import { AutomationLabScreen } from '../src/screens/AutomationLabScreen';

export default function AutomationRoute() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    event?: string | string[];
    payload?: string | string[];
  }>();

  return (
    <AppFrame>
      <AutomationLabScreen
        eventName={firstParam(params.event)}
        eventPayload={firstParam(params.payload)}
        onContinueToCatalog={() => router.replace('/(tabs)/catalog')}
      />
    </AppFrame>
  );
}

function firstParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? 'none';
  return value ?? 'none';
}
