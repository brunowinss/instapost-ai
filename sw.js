self.addEventListener('push', function(event) {
  if (event.data) {
    const data = event.data.json();
    const options = {
      body: data.body,
      icon: data.icon || '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      data: { url: data.url || '/' }
    };
    // Mesmo tipo (ex.: resumo do dia) substitui a notificação anterior em vez de empilhar.
    if (data.tag) { options.tag = data.tag; options.renotify = true; }
    event.waitUntil(
      self.registration.showNotification(data.title, options)
    );
  }
});

// Toque na notificação: abre o app já na tela certa (reaproveita a janela aberta, se houver).
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === self.location.origin) {
        await client.focus();
        if ('navigate' in client) return client.navigate(url);
        return;
      }
    }
    return clients.openWindow(url);
  })());
});
