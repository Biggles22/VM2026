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

type ChatMessage = {
	id: string;
	author: string;
	text: string;
	createdAt: string;
};

type PresenceRecord = {
	path: string;
	updatedAt: string;
};

type RequestBody = {
	subscription?: PushSubscriptionJson;
	title?: string;
	body?: string;
	url?: string;
	icon?: string;
	tag?: string;
	author?: string;
	text?: string;
	id?: string;
	path?: string;
};

type WorkerEnv = Env & {
	SUBSCRIPTIONS: KVNamespace;
	CHAT_MESSAGES?: KVNamespace;
	APISPORTS_KEY?: string;
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
	ADMIN_PUSH_TOKEN?: string;
};

const APISPORTS_KEY_FALLBACK = "170d2afb853fb860d9432d14d7eaaaa5";
const APISPORTS_BASE_URL = "https://v3.football.api-sports.io";
const WORLD_CUP_LEAGUE = 1;
const WORLD_CUP_SEASON = 2026;
const FOOTBALL_TOPSCORERS_CACHE_KEY = "football:topscorers:2026";
const FOOTBALL_TOPSCORERS_CACHE_TTL_SECONDS = 300;
const FIFA_GAMEDAY_TOKEN_URL = "https://cxm-api.fifa.com/fifaplusweb/api/external/gameDay/token";
const FIFA_TOPSCORER_STORY_URL =
	"https://gameday-prod.fifa.mangodev.co.uk/1-0/stories?query=(and%20resourceStatus==`urn:gd:resourceStatus:active`%20_externalId~`urn:gd:story:classification:gcp_top_scorer:competitionId:285023:(.*):rank_asc:page:1$`)&skip=0&limit=1&sort=tags.name==urn:gd:tag:story:fifa:column_number:asc";
const FIFA_REQUEST_HEADERS = {
	accept: "application/json, text/plain, */*",
	"accept-language": "en-US,en;q=0.9",
	origin: "https://www.fifa.com",
	referer: "https://www.fifa.com/",
	"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
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

			if (url.pathname.endsWith("/chat/messages") && request.method === "GET") {
				return handleChatList(request, workerEnv);
			}

			if (url.pathname.endsWith("/chat/messages") && request.method === "POST") {
				return handleChatPost(request, workerEnv);
			}

			if (url.pathname.endsWith("/chat/messages") && request.method === "DELETE") {
				return handleChatClear(request, workerEnv);
			}

			if (url.pathname.endsWith("/presence") && request.method === "GET") {
				return await handlePresenceCount(request, workerEnv);
			}

			if (url.pathname.endsWith("/presence") && request.method === "POST") {
				return await handlePresencePing(request, workerEnv);
			}

			if (url.pathname.endsWith("/football/topscorers") && request.method === "GET") {
				return await handleFootballTopscorers(request, workerEnv);
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
		tag: body.tag || `vm2026-${Date.now()}`,
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
				const deleted = shouldDelete && item.id !== "direct";
				if (deleted) {
					await env.SUBSCRIPTIONS.delete(item.id);
				}
				const message = error instanceof Error ? error.message : String(error);
				console.warn("Push failed", item.id, statusCode, message);
				return { id: item.id, ok: false, statusCode, deleted };
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

async function handleChatList(request: Request, env: WorkerEnv): Promise<Response> {
	assertChatKv(env);

	const messages = await listChatMessages(env);
	return json(request, { ok: true, messages });
}

async function handleChatPost(request: Request, env: WorkerEnv): Promise<Response> {
	assertChatKv(env);

	const body = await readJson(request);
	const author = cleanText(body.author || "Anonym", 32);
	const text = cleanText(body.text || "", 800);
	if (!text) {
		throw new HttpError("Meddelandet ar tomt.", 400);
	}

	const now = new Date();
	const message: ChatMessage = {
		id: crypto.randomUUID(),
		author: author || "Anonym",
		text,
		createdAt: now.toISOString(),
	};
	const key = `chat:message:${now.getTime().toString().padStart(13, "0")}:${message.id}`;

	await chatKv(env).put(key, JSON.stringify(message), {
		expirationTtl: 60 * 60 * 24 * 90,
	});
	await trimChatMessages(env);

	return json(request, { ok: true, message }, 201);
}

async function handleChatClear(request: Request, env: WorkerEnv): Promise<Response> {
	assertChatKv(env);
	assertAdmin(request, env);

	const keys = await listChatKeys(env, 1000);
	await Promise.all(keys.map((key) => chatKv(env).delete(key)));

	return json(request, { ok: true, deleted: keys.length });
}

async function handlePresencePing(request: Request, env: WorkerEnv): Promise<Response> {
	assertKv(env);

	const body = await readJson(request);
	const id = cleanPresenceId(body.id || "");
	if (!id) {
		throw new HttpError("Saknar giltigt sessions-id.", 400);
	}

	const record: PresenceRecord = {
		path: cleanText(body.path || "/", 120),
		updatedAt: new Date().toISOString(),
	};

	await env.SUBSCRIPTIONS.put(`presence:${id}`, JSON.stringify(record), {
		expirationTtl: 600,
	});

	return handlePresenceCount(request, env);
}

async function handleFootballTopscorers(request: Request, env: WorkerEnv): Promise<Response> {
	const cached = await env.SUBSCRIPTIONS.get(FOOTBALL_TOPSCORERS_CACHE_KEY, "json");

	try {
		const result = {
			ok: true,
			source: "fifa-gameday",
			updatedAt: new Date().toISOString(),
			response: await fetchFifaTopscorers(),
		};

		await env.SUBSCRIPTIONS.put(FOOTBALL_TOPSCORERS_CACHE_KEY, JSON.stringify(result), {
			expirationTtl: FOOTBALL_TOPSCORERS_CACHE_TTL_SECONDS,
		});

		return json(request, result);
	} catch (error) {
		console.warn("FIFA GameDay topscorers failed", error);
	}

	const apiKey = env.APISPORTS_KEY || APISPORTS_KEY_FALLBACK;
	const endpoint = `${APISPORTS_BASE_URL}/players/topscorers?league=${WORLD_CUP_LEAGUE}&season=${WORLD_CUP_SEASON}`;
	try {
		const response = await fetch(endpoint, {
			headers: {
				"x-apisports-key": apiKey,
			},
		});

		const text = await response.text();
		if (!response.ok) {
			throw new HttpError(`API-Football svarade ${response.status}: ${text}`, response.status);
		}

		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			throw new HttpError("API-Football svarade inte med giltig JSON.", 502);
		}

		const payload = data as { errors?: unknown; response?: unknown[] };
		if (payload.errors && hasApiErrors(payload.errors)) {
			throw new HttpError(`API-Football-fel: ${JSON.stringify(payload.errors)}`, 502);
		}

		const result = {
			ok: true,
			source: "api-football",
			updatedAt: new Date().toISOString(),
			response: sortTopscorers(Array.isArray(payload.response) ? payload.response : []),
		};

		await env.SUBSCRIPTIONS.put(FOOTBALL_TOPSCORERS_CACHE_KEY, JSON.stringify(result), {
			expirationTtl: FOOTBALL_TOPSCORERS_CACHE_TTL_SECONDS,
		});

		return json(request, result);
	} catch (error) {
		if (cached) {
			return json(request, {
				...(cached as Record<string, unknown>),
				cacheFallback: true,
			});
		}
		throw error;
	}
}

async function handlePresenceCount(request: Request, env: WorkerEnv): Promise<Response> {
	assertKv(env);

	const active = await countPresence(env);
	return json(request, { ok: true, active });
}

async function countPresence(env: WorkerEnv): Promise<number> {
	let active = 0;
	let cursor: string | undefined;

	do {
		const page = await env.SUBSCRIPTIONS.list({ prefix: "presence:", cursor });
		active += page.keys.length;
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);

	return active;
}

function hasApiErrors(errors: unknown): boolean {
	if (!errors) return false;
	if (Array.isArray(errors)) return errors.length > 0;
	if (typeof errors === "object") return Object.keys(errors).length > 0;
	return Boolean(errors);
}

type TopscorerEntry = Record<string, unknown>;

type FifaGameDayActor = {
	key?: {
		_externalSportsPersonId?: string;
		_externalTeamId?: string;
	};
	name?: {
		eng?: string;
	};
	tags?: Array<{
		name?: string;
		value?: unknown;
	}>;
};

async function fetchFifaTopscorers(): Promise<TopscorerEntry[]> {
	const tokenResponse = await fetch(FIFA_GAMEDAY_TOKEN_URL, {
		headers: FIFA_REQUEST_HEADERS,
	});
	const tokenBody = await tokenResponse.text();
	if (!tokenResponse.ok) {
		throw new HttpError(`FIFA token svarade ${tokenResponse.status}: ${tokenBody}`, tokenResponse.status);
	}

	let tokenData: { token?: string };
	try {
		tokenData = JSON.parse(tokenBody) as { token?: string };
	} catch {
		throw new HttpError("FIFA token svarade inte med giltig JSON.", 502);
	}

	if (!tokenData.token) {
		throw new HttpError("FIFA token saknas.", 502);
	}

	const response = await fetch(FIFA_TOPSCORER_STORY_URL, {
		headers: {
			...FIFA_REQUEST_HEADERS,
			authorization: `Bearer ${tokenData.token}`,
		},
	});
	const text = await response.text();
	if (!response.ok) {
		throw new HttpError(`FIFA GameDay svarade ${response.status}: ${text}`, response.status);
	}

	let data: { items?: Array<{ actors?: FifaGameDayActor[] }> };
	try {
		data = JSON.parse(text) as { items?: Array<{ actors?: FifaGameDayActor[] }> };
	} catch {
		throw new HttpError("FIFA GameDay svarade inte med giltig JSON.", 502);
	}

	const actors = data.items?.[0]?.actors || [];
	const players = actors
		.map(createFifaTopscorerEntry)
		.filter((player) => Number(scorerStats(player).goals?.total || 0) > 0);

	if (!players.length) {
		throw new HttpError("FIFA GameDay saknar skytteligaspelare.", 502);
	}

	return sortTopscorers(players);
}

function createFifaTopscorerEntry(actor: FifaGameDayActor): TopscorerEntry {
	const team = {
		id: actor.key?._externalTeamId,
		name: fifaTagValue(actor, "urn:gd:tag:story:team:name:eng") || "-",
		logo: fifaTagValue(actor, "urn:gd:tag:story:team:image"),
	};

	return {
		player: {
			id: actor.key?._externalSportsPersonId,
			name: actor.name?.eng || fifaTagValue(actor, "urn:gd:tag:story:staff:display_name:eng") || "-",
			nationality: team.name,
			photo: fifaTagValue(actor, "urn:gd:tag:story:staff:image"),
		},
		team,
		statistics: [{
			team,
			games: {
				minutes: fifaNumberTag(actor, "urn:gd:tag:football:stats:total_competition_minutes_played"),
				hasMinutes: true,
			},
			goals: {
				total: fifaNumberTag(actor, "urn:gd:tag:football:stats:goals"),
				assists: fifaNumberTag(actor, "urn:gd:tag:football:stats:assists"),
			},
			penalties: { total: null },
			penalty: { scored: null },
			source: "FIFA GameDay",
			rank: fifaNumberTag(actor, "urn:gd:tag:football:stats:fdcp_top_scorer_rank"),
		}],
	};
}

function fifaTagValue(actor: FifaGameDayActor, tagName: string): string {
	const value = actor.tags?.find((tag) => tag.name === tagName)?.value;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

function fifaNumberTag(actor: FifaGameDayActor, tagName: string): number {
	const value = Number(fifaTagValue(actor, tagName));
	return Number.isFinite(value) ? value : 0;
}

function sortTopscorers(players: unknown[]): TopscorerEntry[] {
	return (players as TopscorerEntry[]).slice().sort(compareTopscorers);
}

function scorerStats(player: TopscorerEntry): { goals?: { total?: number; assists?: number }; games?: { minutes?: number } } {
	return (player.statistics as Array<{ goals?: { total?: number; assists?: number }; games?: { minutes?: number } }> | undefined)?.[0] || {};
}

function compareTopscorers(a: TopscorerEntry, b: TopscorerEntry): number {
	const aStats = (a.statistics as Array<{ goals?: { total?: number; assists?: number }; games?: { minutes?: number } }> | undefined)?.[0] || {};
	const bStats = (b.statistics as Array<{ goals?: { total?: number; assists?: number }; games?: { minutes?: number } }> | undefined)?.[0] || {};
	const goalDiff = Number(bStats.goals?.total || 0) - Number(aStats.goals?.total || 0);
	if (goalDiff) return goalDiff;
	const assistDiff = Number(bStats.goals?.assists || 0) - Number(aStats.goals?.assists || 0);
	if (assistDiff) return assistDiff;
	const minuteDiff = Number(aStats.games?.minutes || Number.MAX_SAFE_INTEGER) - Number(bStats.games?.minutes || Number.MAX_SAFE_INTEGER);
	if (minuteDiff) return minuteDiff;
	return String((a.player as { name?: string } | undefined)?.name || "").localeCompare(String((b.player as { name?: string } | undefined)?.name || ""), "sv");
}

async function listChatMessages(env: WorkerEnv): Promise<ChatMessage[]> {
	const keys = await listChatKeys(env, 200);
	const messages = await Promise.all(keys.map((key) => chatKv(env).get<ChatMessage>(key, "json")));
	return messages
		.filter((message): message is ChatMessage => Boolean(message?.id && message.text && message.createdAt))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
		.slice(-100);
}

async function listChatKeys(env: WorkerEnv, limit: number): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;

	do {
		const page = await chatKv(env).list({ prefix: "chat:message:", cursor, limit: Math.min(limit, 1000) });
		keys.push(...page.keys.map((key) => key.name));
		cursor = page.list_complete || keys.length >= limit ? undefined : page.cursor;
	} while (cursor);

	return keys.sort();
}

async function trimChatMessages(env: WorkerEnv): Promise<void> {
	const keys = await listChatKeys(env, 500);
	const staleKeys = keys.slice(0, Math.max(0, keys.length - 200));
	await Promise.all(staleKeys.map((key) => chatKv(env).delete(key)));
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

function assertChatKv(env: WorkerEnv): void {
	if (!chatKv(env)) {
		throw new Error("KV-binding for chat saknas.");
	}
}

function chatKv(env: WorkerEnv): KVNamespace {
	return env.CHAT_MESSAGES || env.SUBSCRIPTIONS;
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

function cleanText(value: string, maxLength: number): string {
	return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanPresenceId(value: string): string {
	const id = value.trim();
	return /^[a-zA-Z0-9-]{8,80}$/.test(id) ? id : "";
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
