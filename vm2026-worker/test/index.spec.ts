import { env, createExecutionContext, waitOnExecutionContext, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const subscription = {
	endpoint: "https://push.example.test/subscription/1",
	keys: {
		p256dh: "p256dh-key",
		auth: "auth-key",
	},
};

describe("VM2026 push worker", () => {
	it("returns the configured public key", async () => {
		const request = new IncomingRequest("https://vm2026.info/api/push/public-key");
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, { ...env, VAPID_PUBLIC_KEY: "public-key" }, ctx);

		await waitOnExecutionContext(ctx);
		await expect(response.json()).resolves.toEqual({ publicKey: "public-key" });
	});

	it("stores subscriptions", async () => {
		const request = new IncomingRequest("https://vm2026.info/api/push/subscribe", {
			method: "POST",
			body: JSON.stringify({ subscription }),
			headers: { "content-type": "application/json" },
		});
		const ctx = createExecutionContext();

		const response = await worker.fetch(request, env, ctx);

		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ ok: true });
	});

	it("handles CORS preflight", async () => {
		const response = await SELF.fetch("https://vm2026.info/api/push/subscribe", {
			method: "OPTIONS",
			headers: { origin: "https://vm2026.info" },
		});

		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe("https://vm2026.info");
	});

	it("stores and lists chat messages", async () => {
		const postRequest = new IncomingRequest("https://vm2026.info/api/chat/messages", {
			method: "POST",
			body: JSON.stringify({ author: "Anders", text: "Hej chatten" }),
			headers: { "content-type": "application/json" },
		});
		const ctx = createExecutionContext();

		const postResponse = await worker.fetch(postRequest, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(postResponse.status).toBe(201);
		await expect(postResponse.json()).resolves.toMatchObject({
			ok: true,
			message: { author: "Anders", text: "Hej chatten" },
		});

		const listRequest = new IncomingRequest("https://vm2026.info/api/chat/messages");
		const listResponse = await worker.fetch(listRequest, env, createExecutionContext());

		expect(listResponse.status).toBe(200);
		await expect(listResponse.json()).resolves.toMatchObject({
			ok: true,
			messages: [expect.objectContaining({ author: "Anders", text: "Hej chatten" })],
		});
	});
});
