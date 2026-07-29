export function clearStateLaunchUrlMaestroFlow(appId: string): string {
  return `appId: ${JSON.stringify(appId)}
name: Clear state launch URL
---
- launchApp:
    clearState: true
- assertVisible:
    text: Automation lab
- assertVisible:
    text: cold.start
`;
}
