import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURSOR_PROVIDER } from "./cursor-model.js";
import {
	AUTH_CURSOR_SDK_ERROR_MESSAGE,
	CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE,
	MISSING_CURSOR_API_KEY_MESSAGE,
} from "./cursor-provider-errors.js";

/**
 * Queue pi's built-in `/reload` after Cursor auth failures.
 *
 * In practice the existing stored/`CURSOR_API_KEY` credential is often still
 * valid — `/reload` re-resolves it and recreates the Cursor SDK agent. The same
 * path also picks up a newly saved `/login` key or an updated env value.
 *
 * Cooldown prevents a reload loop when the key remains invalid.
 */
export const CURSOR_AUTH_RELOAD_COMMAND = "/reload";
export const CURSOR_AUTH_RELOAD_COOLDOWN_MS = 60_000;

const AUTH_FAILURE_MESSAGES = new Set([
	AUTH_CURSOR_SDK_ERROR_MESSAGE,
	CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE,
	MISSING_CURSOR_API_KEY_MESSAGE,
]);

export function isCursorAuthFailureErrorMessage(errorMessage: string | undefined): boolean {
	const message = errorMessage?.trim();
	if (!message) return false;
	if (AUTH_FAILURE_MESSAGES.has(message)) return true;
	return (
		/Cursor SDK API key may be invalid or unauthorized/i.test(message) ||
		/Cursor SDK runs require a Cursor SDK API key/i.test(message) ||
		/Cloud API authentication rejected the API key/i.test(message)
	);
}

export function shouldQueueCursorAuthReload(options: {
	message: AssistantMessage;
	isCursorProvider: boolean;
	lastQueuedAtMs?: number;
	nowMs: number;
	cooldownMs?: number;
}): boolean {
	const { message, isCursorProvider, lastQueuedAtMs, nowMs } = options;
	const cooldownMs = options.cooldownMs ?? CURSOR_AUTH_RELOAD_COOLDOWN_MS;
	if (!isCursorProvider || message.stopReason !== "error") return false;
	if (!isCursorAuthFailureErrorMessage(message.errorMessage)) return false;
	if (lastQueuedAtMs !== undefined && nowMs - lastQueuedAtMs < cooldownMs) return false;
	return true;
}

export type CursorAuthReloadExtensionApi = Pick<ExtensionAPI, "on" | "sendUserMessage">;

export type CursorAuthReloadHandlerOptions = {
	cooldownMs?: number;
	now?: () => number;
};

/**
 * Register a `message_end` handler that queues `/reload` after Cursor auth
 * failures so the existing credential is re-read without a manual `/reload`.
 * Cooldown keeps a still-bad key from looping forever.
 */
export function registerCursorAuthReload(
	pi: CursorAuthReloadExtensionApi,
	options: CursorAuthReloadHandlerOptions = {},
): void {
	const cooldownMs = options.cooldownMs ?? CURSOR_AUTH_RELOAD_COOLDOWN_MS;
	const now = options.now ?? Date.now;
	let lastQueuedAtMs: number | undefined;

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;

		const isCursorProvider = message.provider === CURSOR_PROVIDER || ctx.model?.provider === CURSOR_PROVIDER;
		const nowMs = now();
		if (
			!shouldQueueCursorAuthReload({
				message,
				isCursorProvider,
				lastQueuedAtMs,
				nowMs,
				cooldownMs,
			})
		) {
			return;
		}

		lastQueuedAtMs = nowMs;
		notifyAuthReloadQueued(ctx);
		pi.sendUserMessage(CURSOR_AUTH_RELOAD_COMMAND, { deliverAs: "followUp" });
	});
}

function notifyAuthReloadQueued(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(
		"Cursor auth failed — queuing /reload to re-read the existing API key (no /login required).",
		"warning",
	);
}
