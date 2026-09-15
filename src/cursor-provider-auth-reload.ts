import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CURSOR_PROVIDER } from "./cursor-model.js";
import {
	AUTH_CURSOR_SDK_ERROR_MESSAGE,
	CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE,
	MISSING_CURSOR_API_KEY_MESSAGE,
} from "./cursor-provider-errors.js";

/**
 * After Cursor SDK auth failures or stale-connection aborts (common when a
 * question sat unanswered and the backend timed out), reload the extension
 * runtime and continue the turn.
 *
 * Built-in `/reload` is editor-only — extension `sendUserMessage("/reload")`
 * would be sent to the model. We register `/cursor-sdk-recover` instead and
 * invoke it with `expandPromptTemplates: true` once the agent is idle.
 *
 * Cooldown prevents a reload loop when the key remains invalid.
 */
export const CURSOR_SDK_RECOVER_COMMAND = "cursor-sdk-recover";
export const CURSOR_SDK_RECOVER_SLASH = `/${CURSOR_SDK_RECOVER_COMMAND}`;
/** @deprecated Use CURSOR_SDK_RECOVER_SLASH — kept for older tests/callers. */
export const CURSOR_AUTH_RELOAD_COMMAND = CURSOR_SDK_RECOVER_SLASH;
export const CURSOR_AUTH_RELOAD_COOLDOWN_MS = 60_000;

export const CURSOR_SDK_RECOVER_ENTRY_TYPE = "pi-cursor-sdk:auto-recover";

export const CURSOR_SDK_RECOVER_CONTINUE_PROMPT =
	"A recoverable Cursor SDK error was cleared by reload. Continue from my last request or answer without asking me to repeat it.";

const AUTH_FAILURE_MESSAGES = new Set([
	AUTH_CURSOR_SDK_ERROR_MESSAGE,
	CLOUD_AUTH_CURSOR_SDK_ERROR_MESSAGE,
	MISSING_CURSOR_API_KEY_MESSAGE,
]);

export type CursorSdkRecoverReason = "auth" | "abort";

export type CursorSdkRecoverEntryData = {
	reason: CursorSdkRecoverReason;
	/** When true, session_start(reason=reload) should kick off a continue turn. */
	continue: boolean;
	atMs: number;
};

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

/**
 * Stale SDK connection aborts after idle question UIs / long pauses.
 * Do not match intentional user cancels (`Cancelled: prompt interrupted.`).
 */
export function isCursorRecoverableAbortErrorMessage(errorMessage: string | undefined): boolean {
	const message = errorMessage?.trim();
	if (!message) return false;
	if (/^Cancelled:\s*prompt interrupted\.?$/i.test(message)) return false;
	if (/^Cancelled:\s*Cursor SDK run was cancelled\.?$/i.test(message)) return false;
	return (
		/\bThis operation was aborted\b/i.test(message) ||
		/\bThe operation was aborted\b/i.test(message) ||
		(/\[canceled\]/i.test(message) && /operation was aborted/i.test(message)) ||
		/^Cancelled:\s*Cursor SDK run aborted\.?$/i.test(message)
	);
}

export function classifyCursorRecoverableErrorMessage(
	errorMessage: string | undefined,
): CursorSdkRecoverReason | undefined {
	if (isCursorAuthFailureErrorMessage(errorMessage)) return "auth";
	if (isCursorRecoverableAbortErrorMessage(errorMessage)) return "abort";
	return undefined;
}

export function isCursorRecoverableErrorMessage(errorMessage: string | undefined): boolean {
	return classifyCursorRecoverableErrorMessage(errorMessage) !== undefined;
}

export function shouldQueueCursorAuthReload(options: {
	message: AssistantMessage;
	isCursorProvider: boolean;
	lastQueuedAtMs?: number;
	nowMs: number;
	cooldownMs?: number;
}): boolean {
	return shouldQueueCursorSdkRecover(options) !== undefined;
}

export function shouldQueueCursorSdkRecover(options: {
	message: AssistantMessage;
	isCursorProvider: boolean;
	lastQueuedAtMs?: number;
	nowMs: number;
	cooldownMs?: number;
}): CursorSdkRecoverReason | undefined {
	const { message, isCursorProvider, lastQueuedAtMs, nowMs } = options;
	const cooldownMs = options.cooldownMs ?? CURSOR_AUTH_RELOAD_COOLDOWN_MS;
	if (!isCursorProvider || message.stopReason !== "error") return undefined;
	const reason = classifyCursorRecoverableErrorMessage(message.errorMessage);
	if (!reason) return undefined;
	if (lastQueuedAtMs !== undefined && nowMs - lastQueuedAtMs < cooldownMs) return undefined;
	return reason;
}

export type CursorAuthReloadExtensionApi = Omit<
	Pick<ExtensionAPI, "on" | "sendUserMessage" | "registerCommand" | "appendEntry">,
	"sendUserMessage"
> & {
	/**
	 * pi >= 0.85 supports expandPromptTemplates to dispatch extension commands.
	 * Keep the option in our local type so we typecheck against older peer stubs.
	 */
	sendUserMessage: (
		content: string,
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	) => void;
};

export type CursorAuthReloadHandlerOptions = {
	cooldownMs?: number;
	now?: () => number;
};

type PendingRecover = {
	reason: CursorSdkRecoverReason;
	queuedAtMs: number;
};

/**
 * Register recover command + handlers:
 * - `message_end`: detect auth/abort errors
 * - `agent_settled`: run `/cursor-sdk-recover` (reload) once idle
 * - `session_start(reload)`: continue the prior turn
 */
export function registerCursorAuthReload(
	pi: CursorAuthReloadExtensionApi,
	options: CursorAuthReloadHandlerOptions = {},
): void {
	const cooldownMs = options.cooldownMs ?? CURSOR_AUTH_RELOAD_COOLDOWN_MS;
	const now = options.now ?? Date.now;
	let lastQueuedAtMs: number | undefined;
	let pending: PendingRecover | undefined;
	let recoverDispatched = false;

	pi.registerCommand(CURSOR_SDK_RECOVER_COMMAND, {
		description:
			"Reload after a Cursor SDK auth or aborted-connection error, then continue the prior turn",
		handler: async (_args, ctx) => {
			const reason = pending?.reason ?? "auth";
			pending = undefined;
			recoverDispatched = false;
			pi.appendEntry<CursorSdkRecoverEntryData>(CURSOR_SDK_RECOVER_ENTRY_TYPE, {
				reason,
				continue: true,
				atMs: now(),
			});
			await ctx.reload();
			return;
		},
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;

		const isCursorProvider = message.provider === CURSOR_PROVIDER || ctx.model?.provider === CURSOR_PROVIDER;
		const nowMs = now();
		const reason = shouldQueueCursorSdkRecover({
			message,
			isCursorProvider,
			lastQueuedAtMs,
			nowMs,
			cooldownMs,
		});
		if (!reason) return;

		lastQueuedAtMs = nowMs;
		pending = { reason, queuedAtMs: nowMs };
		recoverDispatched = false;
		notifyRecoverQueued(ctx, reason);
	});

	pi.on("agent_settled", () => {
		if (!pending || recoverDispatched) return;
		const queued = pending;
		if (now() - queued.queuedAtMs > cooldownMs) {
			pending = undefined;
			return;
		}
		recoverDispatched = true;
		// Defer so we are fully idle before dispatching the recover command.
		queueMicrotask(() => {
			pi.sendUserMessage(CURSOR_SDK_RECOVER_SLASH, { expandPromptTemplates: true });
		});
	});

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") return;
		const entry = findLatestPendingRecoverEntry(ctx.sessionManager.getEntries?.() ?? [], now());
		if (!entry) return;
		// Consume so a later manual /reload does not re-continue.
		pi.appendEntry<CursorSdkRecoverEntryData>(CURSOR_SDK_RECOVER_ENTRY_TYPE, {
			reason: entry.reason,
			continue: false,
			atMs: now(),
		});
		notifyRecoverContinue(ctx, entry.reason);
		queueMicrotask(() => {
			pi.sendUserMessage(CURSOR_SDK_RECOVER_CONTINUE_PROMPT);
		});
	});
}

function findLatestPendingRecoverEntry(
	entries: Array<{ type?: string; customType?: string; data?: unknown }>,
	nowMs: number,
): CursorSdkRecoverEntryData | undefined {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== CURSOR_SDK_RECOVER_ENTRY_TYPE) continue;
		const data = entry.data as CursorSdkRecoverEntryData | undefined;
		if (!data || typeof data.atMs !== "number") continue;
		// Only honor a pending-continue written immediately before this reload.
		if (!data.continue) return undefined;
		if (nowMs - data.atMs > CURSOR_AUTH_RELOAD_COOLDOWN_MS) return undefined;
		return data;
	}
	return undefined;
}

function notifyRecoverQueued(ctx: Pick<ExtensionContext, "hasUI" | "ui">, reason: CursorSdkRecoverReason): void {
	if (!ctx.hasUI) return;
	const detail =
		reason === "auth"
			? "API key auth failed — queuing reload to re-read CURSOR_API_KEY /login credentials"
			: "Cursor SDK connection aborted — queuing reload (common after a long idle question)";
	ctx.ui.notify(`${detail}, then continuing.`, "warning");
}

function notifyRecoverContinue(ctx: Pick<ExtensionContext, "hasUI" | "ui">, reason: CursorSdkRecoverReason): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(
		`Cursor SDK recovered after ${reason === "auth" ? "auth" : "abort"} — continuing prior turn.`,
		"info",
	);
}
