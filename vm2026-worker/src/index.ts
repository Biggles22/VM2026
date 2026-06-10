import webPush from "web-push";

type PushSubscriptionJson = {
	endpoint: string;
	keys: {
		p256dh: string;
		auth: string;
	};
};

type SubscriptionRecord = {
	subscription: PushSubscriptionJson;
	createdAt: string;
};

type PushPayload = {
	title: string;
	body: string;
	url: string;
	icon: string;
	tag: string;
};

type RequestBody = {
	subscription?: PushSubscriptionJson;
	title?: string;
	body?: string;
	url?: string;
	icon?: string;
	tag?: string;
};

type WorkerEnv = Env & {
	SUBSCRIPTIONS: KVNamespace;
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
	ADMIN_PUSH_TOKEN?: string;
};

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
};

export default {
	async fetch(request, env): Promise<Response> {
		const workerEnv = env as WorkerEnv;
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return withCors(request, new Response(null, { status: 204 }));
		}

		try {
			if (url.pathname.endsWith("/public-key") && request.method === "GET") {
				return json(request, { publicKey: workerEnv.VAPID_PUBLIC_KEY || "" });
			}

			if (url.pathname.endsWith("/subscribe") && request.method === "POST") {
				return handleSubscribe(request, workerEnv);
			}

			if (url.pathname.endsWith("/subscribe") && request.method === "DELETE") {
				return handleUnsubscribe(request, workerEnv);
			}

			if (url.pathname.endsWith("/send") && request.method === "POST") {
				return handleSend(request, workerEnv);
			}

			return json(request, { error: "Not found" }, 404);
		} catch (error) {
			console.error(error);
			const status = error instanceof HttpError ? error.status : 500;
			const message = error instanceof Error ? error.message : "Worker error";
			return json(request, { error: message }, status);
		}
	},
} satisfies ExportedHandler<Env>;

async function handleSubscribe(request: Request, env: WorkerEnv): Promise<Response> {
	assertKv(env);
	const body = await readJson(request);
	const subscription = body.subscription || (body as PushSubscriptionJson);
	validateSubscription(subscription);

	const id = await subscriptionId(subscription);
	await env.SUBSCRIPTIONS.put(
		id,
		JSON.stringify({
			subscription,
			createdAt: new Date().toISOString(),
		} satisfies SubscriptionRecord),
	);

	return json(request, { ok: true, id });
}

async function handleUnsubscribe(request: Request, env: WorkerEnv): Promise<Response> {
	assertKv(env);
	const body = await readJson(request);
	const subscription = body.subscription || (body as PushSubscriptionJson);
	validateSubscription(subscription);

	const id = await subscriptionId(subscription);
	await env.SUBSCRIPTIONS.delete(id);

	return json(request, { ok: true, id });
}

async function handleSend(request: Request, env: WorkerEnv): Promise<Response> {
	assertKv(env);
	assertAdmin(request, env);
	assertVapid(env);

	const body = await readJson(request);
	const directSubscription = body.subscription;
	if (directSubscription) {
		validateSubscription(directSubscription);
	}

	const payload: PushPayload = {
		title: body.title || "VM 2026",
		body: body.body || "Ny uppdatering finns pa vm2026.info.",
		url: body.url || "/",
		icon: body.icon || "/2026_FIFA_World_Cup_emblem.svg.webp",
		tag: body.tag || "vm2026",
	};

	webPush.setVapidDetails(
		env.VAPID_SUBJECT || "mailto:admin@vm2026.info",
		env.VAPID_PUBLIC_KEY,
		env.VAPID_PRIVATE_KEY,
	);

	const subscriptions = await listSubscriptions(env);
	const targets = uniqueSubscriptions(
		directSubscription ? [{ id: "direct", subscription: directSubscription }] : [],
		subscriptions,
	);
	const results = await Promise.all(
		targets.map(async (item) => {
			try {
				await webPush.sendNotification(item.subscription, JSON.stringify(payload));
				return { id: item.id, ok: true, deleted: false };
			} catch (error) {
				const statusCode = statusFromError(error);
				const shouldDelete = isExpiredSubscriptionStatus(statusCode);
				if (shouldDelete && item.id !== "direct") {
					await env.SUBSCRIPTIONS.delete(item.id);
				}
				const message = error instanceof Error ? error.message : String(error);
				console.warn("Push failed", item.id, statusCode, message);
				return { id: item.id, ok: false, statusCode, deleted: shouldDelete };
			}
		}),
	);

	return json(request, {
		ok: true,
		sent: results.filter((result) => result.ok).length,
		failed: results.filter((result) => !result.ok).length,
		deleted: results.filter((result) => result.deleted).length,
		total: results.length,
	});
}

async function listSubscriptions(env: WorkerEnv): Promise<Array<{ id: string; subscription: PushSubscriptionJson }>> {
	const items: Array<{ id: string; subscription: PushSubscriptionJson }> = [];
	let cursor: string | undefined;

	do {
		const page = await env.SUBSCRIPTIONS.list({ cursor });
		cursor = page.list_complete ? undefined : page.cursor;

		await Promise.all(
			page.keys.map(async (key) => {
				const value = await env.SUBSCRIPTIONS.get<SubscriptionRecord>(key.name, "json");
				if (value?.subscription) {
					items.push({ id: key.name, subscription: value.subscription });
				}
			}),
		);
	} while (cursor);

	return items;
}

async function readJson(request: Request): Promise<RequestBody> {
	try {
		return await request.json();
	} catch {
		throw new HttpError("Ogiltig JSON.", 400);
	}
}

function validateSubscription(subscription: unknown): asserts subscription is PushSubscriptionJson {
	if (
		typeof subscription !== "object" ||
		subscription === null ||
		!("endpoint" in subscription) ||
		!("keys" in subscription)
	) {
		throw new Error("Push-prenumerationen saknar endpoint eller nycklar.");
	}

	const candidate = subscription as Partial<PushSubscriptionJson>;
	if (!candidate.endpoint || !candidate.keys?.p256dh || !candidate.keys?.auth) {
		throw new Error("Push-prenumerationen saknar endpoint eller nycklar.");
	}
}

function assertKv(env: WorkerEnv): void {
	if (!env.SUBSCRIPTIONS) {
		throw new Error("KV-binding SUBSCRIPTIONS saknas.");
	}
}

function assertVapid(env: WorkerEnv): asserts env is WorkerEnv & {
	VAPID_PUBLIC_KEY: string;
	VAPID_PRIVATE_KEY: string;
} {
	if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
		throw new Error("VAPID_PUBLIC_KEY eller VAPID_PRIVATE_KEY saknas.");
	}
}

function assertAdmin(request: Request, env: WorkerEnv): void {
	const expected = env.ADMIN_PUSH_TOKEN;
	const provided = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

	if (!expected || provided !== expected) {
		throw new HttpError("Saknar behorig admin-token.", 401);
	}
}

class HttpError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
	}
}

async function subscriptionId(subscription: PushSubscriptionJson): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subscription.endpoint));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(request: Request, data: unknown, status = 200): Response {
	return withCors(
		request,
		new Response(JSON.stringify(data), {
			status,
			headers: JSON_HEADERS,
		}),
	);
}

function withCors(request: Request, response: Response): Response {
	const headers = new Headers(response.headers);
	const origin = request.headers.get("origin") || "*";

	headers.set("access-control-allow-origin", origin);
	headers.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
	headers.set("access-control-allow-headers", "content-type,authorization");
	headers.set("vary", "origin");

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function statusFromError(error: unknown): number | undefined {
	if (typeof error === "object" && error !== null) {
		const candidate = error as { statusCode?: unknown; status?: unknown };
		if (typeof candidate.statusCode === "number") return candidate.statusCode;
		if (typeof candidate.status === "number") return candidate.status;
	}
	return undefined;
}

function isExpiredSubscriptionStatus(statusCode: number | undefined): boolean {
	return statusCode === 400 || statusCode === 403 || statusCode === 404 || statusCode === 410;
}

function uniqueSubscriptions(
	...groups: Array<Array<{ id: string; subscription: PushSubscriptionJson }>>
): Array<{ id: string; subscription: PushSubscriptionJson }> {
	const byEndpoint = new Map<string, { id: string; subscription: PushSubscriptionJson }>();
	for (const item of groups.flat()) {
		if (!byEndpoint.has(item.subscription.endpoint)) {
			byEndpoint.set(item.subscription.endpoint, item);
		}
	}
	return [...byEndpoint.values()];
}
