import { describe, expect, it, vi } from "vitest";
import {
	AUTH_CURSOR_SDK_ERROR_MESSAGE,
	CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE,
	MISSING_CURSOR_API_KEY_MESSAGE,
} from "../src/cursor-provider-errors.js";
import {
	CURSOR_AUTH_RELOAD_COMMAND,
	CURSOR_AUTH_RELOAD_COOLDOWN_MS,
	isCursorAuthFailureErrorMessage,
	registerCursorAuthReload,
	shouldQueueCursorAuthReload,
} from "../src/cursor-provider-auth-reload.js";
import { makeAssistantMessage } from "./helpers/pi-harness.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

function assistantError(provider: string | undefined, errorMessage?: string): AssistantMessage {
	return {
		...makeAssistantMessage(""),
		...(provider ? { provider } : {}),
		stopReason: "error",
		...(errorMessage !== undefined ? { errorMessage } : {}),
	};
}

describe("isCursorAuthFailureErrorMessage", () => {
	it("matches the canonical Cursor auth failure strings", () => {
		expect(isCursorAuthFailureErrorMessage(AUTH_CURSOR_SDK_ERROR_MESSAGE)).toBe(true);
		expect(isCursorAuthFailureErrorMessage(MISSING_CURSOR_API_KEY_MESSAGE)).toBe(true);
		expect(isCursorAuthFailureErrorMessage(CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE)).toBe(true);
	});

	it("matches common auth failure phrases and rejects unrelated errors", () => {
		expect(isCursorAuthFailureErrorMessage("Cursor SDK API key may be invalid or unauthorized")).toBe(true);
		expect(isCursorAuthFailureErrorMessage("Network error: Cursor SDK request failed")).toBe(false);
		expect(isCursorAuthFailureErrorMessage("prompt is too long")).toBe(false);
		expect(isCursorAuthFailureErrorMessage(undefined)).toBe(false);
	});
});

describe("shouldQueueCursorAuthReload", () => {
	it("queues once for Cursor auth errors and respects cooldown", () => {
		const message = assistantError("cursor", AUTH_CURSOR_SDK_ERROR_MESSAGE);
		expect(
			shouldQueueCursorAuthReload({
				message,
				isCursorProvider: true,
				nowMs: 1_000,
			}),
		).toBe(true);
		expect(
			shouldQueueCursorAuthReload({
				message,
				isCursorProvider: true,
				lastQueuedAtMs: 1_000,
				nowMs: 1_000 + CURSOR_AUTH_RELOAD_COOLDOWN_MS - 1,
			}),
		).toBe(false);
		expect(
			shouldQueueCursorAuthReload({
				message,
				isCursorProvider: true,
				lastQueuedAtMs: 1_000,
				nowMs: 1_000 + CURSOR_AUTH_RELOAD_COOLDOWN_MS,
			}),
		).toBe(true);
	});

	it("ignores non-Cursor providers and non-auth errors", () => {
		expect(
			shouldQueueCursorAuthReload({
				message: assistantError("cursor", AUTH_CURSOR_SDK_ERROR_MESSAGE),
				isCursorProvider: false,
				nowMs: 0,
			}),
		).toBe(false);
		expect(
			shouldQueueCursorAuthReload({
				message: assistantError("cursor", "Network error: Cursor SDK request failed"),
				isCursorProvider: true,
				nowMs: 0,
			}),
		).toBe(false);
		expect(
			shouldQueueCursorAuthReload({
				message: { ...assistantError("cursor", AUTH_CURSOR_SDK_ERROR_MESSAGE), stopReason: "stop" },
				isCursorProvider: true,
				nowMs: 0,
			}),
		).toBe(false);
	});
});

describe("registerCursorAuthReload", () => {
	it("queues /reload as a follow-up on Cursor auth failure and notifies once per cooldown", () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const sendUserMessage = vi.fn();
		const notify = vi.fn();
		let nowMs = 10_000;

		registerCursorAuthReload(
			{
				on: (event, handler) => {
					const list = handlers.get(event) ?? [];
					list.push(handler as (event: unknown, ctx: unknown) => unknown);
					handlers.set(event, list);
				},
				sendUserMessage,
			},
			{ now: () => nowMs, cooldownMs: 1_000 },
		);

		const messageEnd = handlers.get("message_end");
		expect(messageEnd).toHaveLength(1);

		const event = { message: assistantError("cursor", AUTH_CURSOR_SDK_ERROR_MESSAGE) };
		const ctx = { model: { provider: "cursor" }, hasUI: true, ui: { notify } };

		messageEnd![0](event, ctx);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);
		expect(sendUserMessage).toHaveBeenCalledWith(CURSOR_AUTH_RELOAD_COMMAND, { deliverAs: "followUp" });
		expect(notify).toHaveBeenCalledTimes(1);

		messageEnd![0](event, ctx);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);

		nowMs += 1_000;
		messageEnd![0](event, ctx);
		expect(sendUserMessage).toHaveBeenCalledTimes(2);
	});

	it("does not queue reload for unrelated Cursor errors", () => {
		const sendUserMessage = vi.fn();
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		registerCursorAuthReload({
			on: (event, handler) => {
				const list = handlers.get(event) ?? [];
				list.push(handler as (event: unknown, ctx: unknown) => unknown);
				handlers.set(event, list);
			},
			sendUserMessage,
		});

		handlers.get("message_end")![0](
			{ message: assistantError("cursor", "Network error: Cursor SDK request failed") },
			{ model: { provider: "cursor" }, hasUI: false, ui: { notify: vi.fn() } },
		);
		expect(sendUserMessage).not.toHaveBeenCalled();
	});
});
