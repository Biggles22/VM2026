self.addEventListener("push", event => {
  const fallback = {
    title: "VM 2026",
    body: "Ny uppdatering finns pa vm2026.info.",
    url: "/",
    icon: "/2026_FIFA_World_Cup_emblem.svg.webp",
    tag: "vm2026"
  };

  const data = event.data ? { ...fallback, ...event.data.json() } : fallback;

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: data.icon,
    badge: data.icon,
    tag: data.tag,
    data: { url: data.url || "/" }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil((async () => {
    const windowClients = await clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    for (const client of windowClients) {
      if (client.url === url && "focus" in client) return client.focus();
    }

    return clients.openWindow(url);
  })());
});
