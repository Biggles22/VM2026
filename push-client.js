(function () {
  const API_BASE = "https://vm2026-worker.anders-h-engstrom.workers.dev/api/push";
  const statusEl = document.getElementById("pushStatus");
  const enableButton = document.getElementById("enablePush");
  const disableButton = document.getElementById("disablePush");
  const sendForm = document.getElementById("sendPushForm");

  function setStatus(message, type) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.dataset.type = type || "info";
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

    return navigator.serviceWorker.register("/sw.js");
  }

  async function getPublicKey() {
    const response = await fetch(`${API_BASE}/public-key`);
    if (!response.ok) throw new Error("Kunde inte hamta publik VAPID-nyckel.");
    const data = await response.json();
    if (!data.publicKey) throw new Error("Publik VAPID-nyckel saknas i Workern.");
    return data.publicKey;
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

    await fetch(`${API_BASE}/subscribe`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription })
    });

    await subscription.unsubscribe();
  }

  async function sendPush(event) {
    event.preventDefault();
    await subscribe();

    const form = new FormData(sendForm);
    const token = form.get("token");

    const response = await fetch(`${API_BASE}/send`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        title: form.get("title"),
        body: form.get("body"),
        url: form.get("url") || "/"
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Kunde inte skicka notisen.");
    return result;
  }

  enableButton?.addEventListener("click", async () => {
    setStatus("Aktiverar notiser...", "info");
    try {
      await subscribe();
      setStatus("Notiser ar aktiverade for den har enheten.", "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });

  disableButton?.addEventListener("click", async () => {
    setStatus("Stanger av notiser...", "info");
    try {
      await unsubscribe();
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
      setStatus(`Skickat: ${result.sent}. Misslyckade: ${result.failed}.${deletedText}`, "success");
    } catch (error) {
      setStatus(error.message, "error");
    }
  });
}());
