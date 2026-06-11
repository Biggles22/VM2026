(function () {
  const WORKER_API_BASE = "https://vm2026-worker.anders-h-engstrom.workers.dev/api/push";
  const API_BASE = WORKER_API_BASE;
  const statusEl = document.getElementById("pushStatus");
  const diagnosticsEl = document.getElementById("pushDiagnostics");
  const enableButton = document.getElementById("enablePush");
  const localTestButton = document.getElementById("localPushTest");
  const disableButton = document.getElementById("disablePush");
  const sendForm = document.getElementById("sendPushForm");

  function setStatus(message, type) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.dataset.type = type || "info";
  }

  function setDiagnostics(lines) {
    if (!diagnosticsEl) return;
    diagnosticsEl.textContent = lines.filter(Boolean).join("\n");
  }

  function base64UrlToUint8Array(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
  }

  async function getRegistration() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("Din webblasare stodjer inte web push.");
    }

    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    return registration;
  }

  async function getDiagnostics() {
    const lines = [
      `URL: ${location.href}`,
      `Secure context: ${window.isSecureContext ? "ja" : "nej"}`,
      `Notification permission: ${"Notification" in window ? Notification.permission : "saknas"}`,
      `ServiceWorker: ${"serviceWorker" in navigator ? "ja" : "nej"}`,
      `PushManager: ${"PushManager" in window ? "ja" : "nej"}`
    ];

    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration("/");
      lines.push(`SW registrerad: ${registration ? "ja" : "nej"}`);
      lines.push(`SW active: ${registration?.active?.state || "nej"}`);
      lines.push(`SW controller: ${navigator.serviceWorker.controller ? "ja" : "nej"}`);
      if (registration && !navigator.serviceWorker.controller) {
        lines.push("Atgard: ladda om sidan en gang sa service workern kontrollerar fliken.");
      }

      const subscription = await registration?.pushManager?.getSubscription?.();
      lines.push(`Prenumeration: ${subscription ? "ja" : "nej"}`);
      if (subscription) {
        lines.push(`Endpoint: ${new URL(subscription.endpoint).host}`);
      }
    }

    return lines;
  }

  async function getPublicKey() {
    const response = await fetch(`${API_BASE}/public-key`);
    if (!response.ok) throw new Error("Kunde inte hamta publik VAPID-nyckel.");
    const data = await response.json();
    if (!data.publicKey) throw new Error("Publik VAPID-nyckel saknas i Workern.");
    return data.publicKey;
  }

  async function removeServerSubscription(subscription) {
    if (!subscription) return;

    await fetch(`${API_BASE}/subscribe`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription })
    }).catch(() => {});
  }

  async function subscribe() {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("Notiser ar inte tillatna i webblasaren.");
    }

    const registration = await getRegistration();
    const publicKey = await getPublicKey();
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await removeServerSubscription(existing);
      await existing.unsubscribe();
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey)
    });

    const response = await fetch(`${API_BASE}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription })
    });

    if (!response.ok) throw new Error("Kunde inte spara prenumerationen.");
    return subscription;
  }

  async function unsubscribe() {
    const registration = await getRegistration();
    const subscription = await registration.pushManager.getSubscription();

    if (!subscription) return;

    await removeServerSubscription(subscription);
    await subscription.unsubscribe();
  }

  async function sendPush(event) {
    event.preventDefault();
    const subscription = await subscribe();

    const form = new FormData(sendForm);
    const token = form.get("token");

    const response = await fetch(`${API_BASE}/send`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        subscription,
        title: form.get("title"),
        body: form.get("body"),
        url: form.get("url") || "/"
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Kunde inte skicka notisen.");
    return result;
  }

  async function showLocalCheckNotification() {
    const registration = await getRegistration();
    await registration.showNotification("VM 2026 lokal kontroll", {
      body: "Om du ser den har fungerar service worker-notiser.",
      tag: `vm2026-local-${Date.now()}`,
      renotify: true,
      requireInteraction: true,
      data: { url: "/push.html" }
    });

    if ("Notification" in window && Notification.permission === "granted") {
      new Notification("VM 2026 direkt kontroll", {
        body: "Om du ser den har fungerar vanliga browser-notiser.",
        tag: `vm2026-direct-${Date.now()}`,
        renotify: true,
        requireInteraction: true
      });
    }

    const worker = registration.active || navigator.serviceWorker.controller;
    if (worker) {
      worker.postMessage({
        type: "SHOW_TEST_NOTIFICATION",
        payload: {
          title: "VM 2026 lokal kontroll",
          body: "Om du ser den har fungerar webblasaren och service workern.",
          url: "/push.html",
          tag: `vm2026-message-${Date.now()}`
        }
      });
      return;
    }
  }

  enableButton?.addEventListener("click", async () => {
    setStatus("Aktiverar notiser...", "info");
    try {
      await subscribe();
      setDiagnostics(await getDiagnostics());
      setStatus("Notiser ar aktiverade for den har enheten.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  localTestButton?.addEventListener("click", async () => {
    setStatus("Testar lokal notis...", "info");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        throw new Error(`Notisbehorighet ar ${permission}.`);
      }
      await showLocalCheckNotification();
      setDiagnostics(await getDiagnostics());
      setStatus("Lokal notis begard. Se diagnostiken nedan.", "success");
    } catch (error) {
      setDiagnostics(await getDiagnostics().catch(() => []));
      setStatus(error.message, "error");
    }
  });

  disableButton?.addEventListener("click", async () => {
    setStatus("Stanger av notiser...", "info");
    try {
      await unsubscribe();
      setDiagnostics(await getDiagnostics());
      setStatus("Notiser ar avstangda for den har enheten.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  sendForm?.addEventListener("submit", async event => {
    setStatus("Aktiverar den har enheten och skickar testnotis...", "info");
    try {
      const result = await sendPush(event);
      if (!result.sent) {
        throw new Error(`Ingen notis skickades. Totalt: ${result.total || 0}. Misslyckade: ${result.failed || 0}.`);
      }
      const deletedText = result.deleted ? ` Rensade gamla: ${result.deleted}.` : "";
      await showLocalCheckNotification();
      setDiagnostics(await getDiagnostics());
      setStatus(`Skickat: ${result.sent}. Misslyckade: ${result.failed}.${deletedText} Lokal kontrollnotis skickad.`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
}());
