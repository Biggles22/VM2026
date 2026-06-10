self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  const fallback = {
    title: "VM 2026",
    body: "Ny uppdatering finns pa vm2026.info.",
    url: "/",
    icon: "/2026_FIFA_World_Cup_emblem.svg.webp",
    tag: "vm2026"
  };

  let data = fallback;
  try {
    data = event.data ? { ...fallback, ...event.data.json() } : fallback;
  } catch (error) {
    console.error("Push payload kunde inte lasas", error);
  }

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: data.icon,
    badge: data.icon,
    tag: data.tag,
    data: { url: data.url || "/" }
  }));
});

self.addEventListener("message", event => {
  if (event.data?.type !== "SHOW_TEST_NOTIFICATION") return;

  const payload = event.data.payload || {};
  event.waitUntil(self.registration.showNotification(payload.title || "VM 2026", {
    body: payload.body || "Lokal kontrollnotis fran service workern.",
    icon: payload.icon || "/2026_FIFA_World_Cup_emblem.svg.webp",
    badge: payload.icon || "/2026_FIFA_World_Cup_emblem.svg.webp",
    tag: payload.tag || "vm2026-local-test",
    data: { url: payload.url || "/" }
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
