import { describe, expect, it, vi } from "vitest";
import {
	AUTH_CURSOR_SDK_ERROR_MESSAGE,
	CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE,
	MISSING_CURSOR_API_KEY_MESSAGE,
} from "../src/cursor-provider-errors.js";
import {
	CURSOR_AUTH_RELOAD_COMMAND,
	CURSOR_AUTH_RELOAD_COOLDOWN_MS,
	CURSOR_SDK_RECOVER_CONTINUE_PROMPT,
	CURSOR_SDK_RECOVER_ENTRY_TYPE,
	CURSOR_SDK_RECOVER_SLASH,
	classifyCursorRecoverableErrorMessage,
	isCursorAuthFailureErrorMessage,
	isCursorRecoverableAbortErrorMessage,
	registerCursorAuthReload,
	shouldQueueCursorAuthReload,
	shouldQueueCursorSdkRecover,
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

describe("isCursorRecoverableAbortErrorMessage", () => {
	it("matches stale abort surfaces and rejects user cancels", () => {
		expect(isCursorRecoverableAbortErrorMessage("This operation was aborted")).toBe(true);
		expect(isCursorRecoverableAbortErrorMessage("Error: This operation was aborted")).toBe(true);
		expect(isCursorRecoverableAbortErrorMessage("[canceled] This operation was aborted")).toBe(true);
		expect(isCursorRecoverableAbortErrorMessage("Cancelled: Cursor SDK run aborted.")).toBe(true);
		expect(isCursorRecoverableAbortErrorMessage("Cancelled: prompt interrupted.")).toBe(false);
		expect(isCursorRecoverableAbortErrorMessage("Cancelled: Cursor SDK run was cancelled.")).toBe(false);
		expect(isCursorRecoverableAbortErrorMessage("Network error: Cursor SDK request failed")).toBe(false);
	});
});

describe("classifyCursorRecoverableErrorMessage", () => {
	it("prefers auth over abort when both could match", () => {
		expect(classifyCursorRecoverableErrorMessage(AUTH_CURSOR_SDK_ERROR_MESSAGE)).toBe("auth");
		expect(classifyCursorRecoverableErrorMessage("This operation was aborted")).toBe("abort");
	});
});

describe("shouldQueueCursorSdkRecover", () => {
	it("queues once for Cursor auth/abort errors and respects cooldown", () => {
		const message = assistantError("cursor", AUTH_CURSOR_SDK_ERROR_MESSAGE);
		expect(
			shouldQueueCursorSdkRecover({
				message,
				isCursorProvider: true,
				nowMs: 1_000,
			}),
		).toBe("auth");
		expect(
			shouldQueueCursorSdkRecover({
				message: assistantError("cursor", "This operation was aborted"),
				isCursorProvider: true,
				nowMs: 1_000,
			}),
		).toBe("abort");
		expect(
			shouldQueueCursorSdkRecover({
				message,
				isCursorProvider: true,
				lastQueuedAtMs: 1_000,
				nowMs: 1_000 + CURSOR_AUTH_RELOAD_COOLDOWN_MS - 1,
			}),
		).toBeUndefined();
		expect(
			shouldQueueCursorSdkRecover({
				message,
				isCursorProvider: true,
				lastQueuedAtMs: 1_000,
				nowMs: 1_000 + CURSOR_AUTH_RELOAD_COOLDOWN_MS,
			}),
		).toBe("auth");
	});

	it("ignores non-Cursor providers and non-recoverable errors", () => {
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
	it("registers recover command and reloads+continues on auth failure", async () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const sendUserMessage = vi.fn();
		const appendEntry = vi.fn();
		const notify = vi.fn();
		const reload = vi.fn(async () => {});
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }>();
		let nowMs = 10_000;

		registerCursorAuthReload(
			{
				on: (event, handler) => {
					const list = handlers.get(event) ?? [];
					list.push(handler as (event: unknown, ctx: unknown) => unknown);
					handlers.set(event, list);
				},
				sendUserMessage,
				appendEntry,
				registerCommand: (name, command) => {
					commands.set(name, command as { handler: (args: string, ctx: unknown) => Promise<unknown> });
				},
			},
			{ now: () => nowMs, cooldownMs: 1_000 },
		);

		expect(commands.has("cursor-sdk-recover")).toBe(true);
		expect(CURSOR_AUTH_RELOAD_COMMAND).toBe(CURSOR_SDK_RECOVER_SLASH);

		const messageEnd = handlers.get("message_end");
		const agentSettled = handlers.get("agent_settled");
		const sessionStart = handlers.get("session_start");
		expect(messageEnd).toHaveLength(1);
		expect(agentSettled).toHaveLength(1);
		expect(sessionStart).toHaveLength(1);

		const ctx = { model: { provider: "cursor" }, hasUI: true, ui: { notify } };
		messageEnd![0]({ message: assistantError("cursor", AUTH_CURSOR_SDK_ERROR_MESSAGE) }, ctx);
		expect(notify).toHaveBeenCalledTimes(1);
		expect(sendUserMessage).not.toHaveBeenCalled();

		agentSettled![0]({}, ctx);
		await Promise.resolve();
		expect(sendUserMessage).toHaveBeenCalledWith(CURSOR_SDK_RECOVER_SLASH, { expandPromptTemplates: true });

		await commands.get("cursor-sdk-recover")!.handler("", { reload });
		expect(appendEntry).toHaveBeenCalledWith(
			CURSOR_SDK_RECOVER_ENTRY_TYPE,
			expect.objectContaining({ reason: "auth", continue: true }),
		);
		expect(reload).toHaveBeenCalledTimes(1);

		const entries = [
			{
				type: "custom",
				customType: CURSOR_SDK_RECOVER_ENTRY_TYPE,
				data: { reason: "auth", continue: true, atMs: nowMs },
			},
		];
		sessionStart![0](
			{ type: "session_start", reason: "reload" },
			{
				hasUI: true,
				ui: { notify },
				sessionManager: { getEntries: () => entries },
			},
		);
		await Promise.resolve();
		expect(sendUserMessage).toHaveBeenCalledWith(CURSOR_SDK_RECOVER_CONTINUE_PROMPT);
	});

	it("recovers from aborted connection errors the same way", async () => {
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const sendUserMessage = vi.fn();
		const appendEntry = vi.fn();
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }>();
		const reload = vi.fn(async () => {});

		registerCursorAuthReload({
			on: (event, handler) => {
				const list = handlers.get(event) ?? [];
				list.push(handler as (event: unknown, ctx: unknown) => unknown);
				handlers.set(event, list);
			},
			sendUserMessage,
			appendEntry,
			registerCommand: (name, command) => {
				commands.set(name, command as { handler: (args: string, ctx: unknown) => Promise<unknown> });
			},
		});

		handlers.get("message_end")![0](
			{ message: assistantError("cursor", "This operation was aborted") },
			{ model: { provider: "cursor" }, hasUI: false, ui: { notify: vi.fn() } },
		);
		handlers.get("agent_settled")![0]({}, {});
		await Promise.resolve();
		expect(sendUserMessage).toHaveBeenCalledWith(CURSOR_SDK_RECOVER_SLASH, { expandPromptTemplates: true });

		await commands.get("cursor-sdk-recover")!.handler("", { reload });
		expect(appendEntry).toHaveBeenCalledWith(
			CURSOR_SDK_RECOVER_ENTRY_TYPE,
			expect.objectContaining({ reason: "abort", continue: true }),
		);
	});

	it("does not queue reload for unrelated Cursor errors", async () => {
		const sendUserMessage = vi.fn();
		const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		registerCursorAuthReload({
			on: (event, handler) => {
				const list = handlers.get(event) ?? [];
				list.push(handler as (event: unknown, ctx: unknown) => unknown);
				handlers.set(event, list);
			},
			sendUserMessage,
			appendEntry: vi.fn(),
			registerCommand: vi.fn(),
		});

		handlers.get("message_end")![0](
			{ message: assistantError("cursor", "Network error: Cursor SDK request failed") },
			{ model: { provider: "cursor" }, hasUI: false, ui: { notify: vi.fn() } },
		);
		handlers.get("agent_settled")![0]({}, {});
		await Promise.resolve();
		expect(sendUserMessage).not.toHaveBeenCalled();
	});
});
