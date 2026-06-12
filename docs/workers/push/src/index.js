import webPush from "web-push";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204 }));
    }

    try {
      if (url.pathname.endsWith("/public-key") && request.method === "GET") {
        return json(request, { publicKey: env.VAPID_PUBLIC_KEY || "" });
      }

      if (url.pathname.endsWith("/subscribe") && request.method === "POST") {
        return handleSubscribe(request, env);
      }

      if (url.pathname.endsWith("/subscribe") && request.method === "DELETE") {
        return handleUnsubscribe(request, env);
      }

      if (url.pathname.endsWith("/send") && request.method === "POST") {
        return handleSend(request, env);
      }

      return json(request, { error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json(request, { error: error.message || "Worker error" }, error.status || 500);
    }
  }
};

async function handleSubscribe(request, env) {
  assertKv(env);
  const body = await readJson(request);
  const subscription = body.subscription || body;
  validateSubscription(subscription);

  const id = await subscriptionId(subscription);
  await env.PUSH_SUBSCRIPTIONS.put(id, JSON.stringify({
    subscription,
    createdAt: new Date().toISOString()
  }));

  return json(request, { ok: true, id });
}

async function handleUnsubscribe(request, env) {
  assertKv(env);
  const body = await readJson(request);
  const subscription = body.subscription || body;
  validateSubscription(subscription);

  const id = await subscriptionId(subscription);
  await env.PUSH_SUBSCRIPTIONS.delete(id);

  return json(request, { ok: true, id });
}

async function handleSend(request, env) {
  assertKv(env);
  assertAdmin(request, env);
  assertVapid(env);

  const body = await readJson(request);
  const payload = {
    title: body.title || "VM 2026",
    body: body.body || "Ny uppdatering finns på vm2026.info.",
    url: body.url || "/",
    icon: body.icon || "/2026_FIFA_World_Cup_emblem.svg.webp",
    tag: body.tag || "vm2026"
  };

  webPush.setVapidDetails(
    env.VAPID_SUBJECT || "mailto:admin@vm2026.info",
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY
  );

  const subscriptions = await listSubscriptions(env);
  const results = await Promise.all(subscriptions.map(async item => {
    try {
      await webPush.sendNotification(item.subscription, JSON.stringify(payload));
      return { id: item.id, ok: true };
    } catch (error) {
      const statusCode = error.statusCode || error.status;
      if (statusCode === 404 || statusCode === 410) {
        await env.PUSH_SUBSCRIPTIONS.delete(item.id);
      }
      console.warn("Push failed", item.id, statusCode, error.message);
      return { id: item.id, ok: false, statusCode };
    }
  }));

  return json(request, {
    ok: true,
    sent: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length,
    total: results.length
  });
}

async function listSubscriptions(env) {
  const items = [];
  let cursor;

  do {
    const page = await env.PUSH_SUBSCRIPTIONS.list({ cursor });
    cursor = page.cursor;

    await Promise.all(page.keys.map(async key => {
      const value = await env.PUSH_SUBSCRIPTIONS.get(key.name, "json");
      if (value?.subscription) {
        items.push({ id: key.name, subscription: value.subscription });
      }
    }));
  } while (cursor);

  return items;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError("Ogiltig JSON.", 400);
  }
}

function validateSubscription(subscription) {
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error("Push-prenumerationen saknar endpoint eller nycklar.");
  }
}

function assertKv(env) {
  if (!env.PUSH_SUBSCRIPTIONS) {
    throw new Error("KV-binding PUSH_SUBSCRIPTIONS saknas.");
  }
}

function assertVapid(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    throw new Error("VAPID_PUBLIC_KEY eller VAPID_PRIVATE_KEY saknas.");
  }
}

function assertAdmin(request, env) {
  const expected = env.ADMIN_PUSH_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!expected || provided !== expected) {
    throw new HttpError("Saknar behorig admin-token.", 401);
  }
}

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function subscriptionId(subscription) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(subscription.endpoint)
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function json(request, data, status = 200) {
  return withCors(request, new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  }));
}

function withCors(request, response) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin") || "*";

  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type,authorization");
  headers.set("vary", "origin");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
