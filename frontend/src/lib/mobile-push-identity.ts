export async function identifyMobilePushUser(currentUser: { id: string }): Promise<void> {
  const plugins = window.Capacitor?.Plugins;
  const oneSignal = plugins?.OneSignalCapacitor;

  if (!oneSignal || !currentUser.id) return;

  const userId = currentUser.id;
  const serverUrl = window.location.origin;

  await oneSignal.login?.({ externalId: userId });
  await oneSignal.addTags?.({
    tags: {
      app: 'ex-mobile',
      server_url: serverUrl,
      user_id: userId,
    },
  });
}

export async function clearMobilePushUser(): Promise<void> {
  const oneSignal = window.Capacitor?.Plugins?.OneSignalCapacitor;
  if (!oneSignal) return;

  await oneSignal.logout?.();
  await oneSignal.removeTags?.({ keys: ['user_id'] });
}

