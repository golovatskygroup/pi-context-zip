import { appendFileSync } from "node:fs";
import { complete } from "@earendil-works/pi-ai";
import {
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionContext,
	convertToLlm,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";

const EXTENSION_NAME = "context-zip";
const SUMMARY_SCHEMA_VERSION = 1;
const AUTO_COMPACT_THRESHOLD_PERCENT = 60;
const MAX_SOURCE_ENTRY_IDS = 400;
const MAX_FACTS_JSON_CHARS = 24_000;
const DEBUG_LOG = process.env.CONTEXT_ZIP_DEBUG_LOG;

type ContextZipDetails = {
	extension: typeof EXTENSION_NAME;
	version: typeof SUMMARY_SCHEMA_VERSION;
	createdAt: string;
	triggerThresholdPercent: number;
	model?: {
		provider?: string;
		id?: string;
		name?: string;
	};
	customInstructions?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	summarizedMessageCount: number;
	turnPrefixMessageCount: number;
	isSplitTurn: boolean;
	readFiles: string[];
	modifiedFiles: string[];
	sourceEntryIds: string[];
	sourceEntryIdsTruncated: boolean;
	previousSummaryIncluded: boolean;
	conversationChars: number;
};

type FileOps = {
	read?: Set<string>;
	written?: Set<string>;
	edited?: Set<string>;
};

type UsageLike = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
};

type BranchEntryLike = {
	id?: string;
	type?: string;
	message?: {
		role?: string;
		[key: string]: unknown;
	};
};

type PendingAutoCompact = {
	key: string;
	reason: string;
	customInstructions: string;
	assistantStopReason?: string;
	usage: {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	};
	queuedAt: string;
};

let lastAutoCompactKey: string | undefined;
let pendingAutoCompact: PendingAutoCompact | undefined;
let autoCompactionInFlight = false;

function sorted(values: Iterable<string> | undefined): string[] {
	return Array.from(values ?? []).filter(Boolean).sort();
}

function fileLists(fileOps: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...sorted(fileOps.written), ...sorted(fileOps.edited)]);
	const readFiles = sorted(fileOps.read).filter((file) => !modified.has(file));
	return {
		readFiles,
		modifiedFiles: sorted(modified),
	};
}

function sourceEntryIds(branchEntries: { id: string }[], firstKeptEntryId: string): {
	sourceEntryIds: string[];
	sourceEntryIdsTruncated: boolean;
} {
	const firstKeptIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	const candidates = firstKeptIndex >= 0 ? branchEntries.slice(0, firstKeptIndex) : branchEntries;
	const ids = candidates.map((entry) => entry.id).filter(Boolean);
	const truncated = ids.length > MAX_SOURCE_ENTRY_IDS;
	return {
		sourceEntryIds: truncated ? ids.slice(-MAX_SOURCE_ENTRY_IDS) : ids,
		sourceEntryIdsTruncated: truncated,
	};
}

function extractPinnedFacts(conversationText: string, details: ContextZipDetails): string {
	const factLines = conversationText
		.split(/\r?\n/)
		.filter((line) => {
			if (/\b[A-Z0-9_]{2,}\b=/.test(line)) return true;
			if (/\b(absolute|exact|deadline|must|never|required|constraint|error|failed|path|port|token|percent|threshold)\b/i.test(line)) {
				return true;
			}
			if (/[./~][\w.-]+\/[\w./-]+/.test(line)) return true;
			return false;
		})
		.slice(-200);

	const payload = {
		files: {
			read: details.readFiles,
			modified: details.modifiedFiles,
		},
		sourceEntryIds: details.sourceEntryIds,
		sourceEntryIdsTruncated: details.sourceEntryIdsTruncated,
		candidateFactLines: factLines,
	};
	const json = JSON.stringify(payload, null, 2);
	if (json.length <= MAX_FACTS_JSON_CHARS) return json;
	return `${json.slice(0, MAX_FACTS_JSON_CHARS)}\n... truncated pinned facts payload ...`;
}

function buildPrompt(args: {
	conversationText: string;
	previousSummary?: string;
	customInstructions?: string;
	details: ContextZipDetails;
}): string {
	const previous = args.previousSummary
		? `\n\nExisting summary to update and preserve:\n<previous-summary>\n${args.previousSummary}\n</previous-summary>`
		: "";
	const custom = args.customInstructions ? `\n\nUser compaction instructions:\n${args.customInstructions}` : "";
	const pinnedFacts = extractPinnedFacts(args.conversationText, args.details);

	return `Create a dense, loss-minimizing continuation summary for an AI coding session.${previous}${custom}

Rules:
- Preserve user goals, constraints, preferences, exact commands, file paths, numeric values, API/model names, errors, decisions, and unfinished work.
- Do not invent facts. If uncertain, say "unknown".
- Prefer exact identifiers over prose: filenames, symbols, flags, environment variables, ports, branch/session ids.
- Keep recent work actionable. The next assistant must be able to continue without the discarded messages.
- Include provenance markers from the pinned facts where useful.
- Output only Markdown in exactly this structure:

## Goal

## Constraints & Preferences

## Progress
### Done
### In Progress
### Blocked

## Key Decisions

## Critical Facts

## Files
<read-files>
</read-files>
<modified-files>
</modified-files>

## Open Questions

## Next Steps

## Provenance

Pinned facts and source metadata:
<pinned-facts>
${pinnedFacts}
</pinned-facts>

Conversation to compress:
<conversation>
${args.conversationText}
	</conversation>`;
}

function usageTokens(usage: UsageLike | undefined): number {
	if (!usage) return 0;
	return (
		usage.totalTokens ??
		(usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
	);
}

function fallbackOversizedTurn(branchEntries: BranchEntryLike[]):
	| { messages: unknown[]; firstKeptEntryId: string }
	| undefined {
	const firstUserIndex = branchEntries.findIndex((entry) => entry.type === "message" && entry.message?.role === "user");
	if (firstUserIndex < 0) return undefined;

	const nextUserIndex = branchEntries.findIndex(
		(entry, index) => index > firstUserIndex && entry.type === "message" && entry.message?.role === "user",
	);
	const firstAssistantIndex = branchEntries.findIndex(
		(entry, index) => index > firstUserIndex && entry.type === "message" && entry.message?.role === "assistant",
	);

	const firstKeptIndex = nextUserIndex >= 0 ? nextUserIndex : firstAssistantIndex;
	if (firstKeptIndex < 0) return undefined;

	const firstKeptEntryId = branchEntries[firstKeptIndex]?.id;
	if (!firstKeptEntryId) return undefined;

	const messages = branchEntries
		.slice(firstUserIndex, firstKeptIndex)
		.map((entry) => entry.message)
		.filter(Boolean);
	if (messages.length === 0) return undefined;

	return { messages, firstKeptEntryId };
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function debug(event: string, data: Record<string, unknown>) {
	if (!DEBUG_LOG) return;
	appendFileSync(DEBUG_LOG, `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
}

function compactAsync(ctx: ExtensionContext, customInstructions?: string): Promise<CompactionResult> {
	return new Promise((resolve, reject) => {
		ctx.compact({
			customInstructions,
			onComplete: resolve,
			onError: reject,
		});
	});
}

async function triggerCompaction(
	ctx: ExtensionContext,
	reason: string,
	customInstructions?: string,
): Promise<CompactionResult | undefined> {
	debug("trigger_compaction", { reason, customInstructions });
	notify(ctx, `${EXTENSION_NAME}: compaction requested (${reason})`);
	try {
		const result = await compactAsync(ctx, customInstructions);
		debug("compact_complete", { tokensBefore: result.tokensBefore, firstKeptEntryId: result.firstKeptEntryId });
		notify(ctx, `${EXTENSION_NAME}: compacted ${result.tokensBefore.toLocaleString()} tokens`);
		return result;
	} catch (error) {
		const err = error instanceof Error ? error : new Error(String(error));
		debug("compact_error", { message: err.message });
		notify(ctx, `${EXTENSION_NAME}: compaction failed: ${err.message}`, "error");
		return undefined;
	}
}

function queueAutoCompaction(request: PendingAutoCompact, ctx: ExtensionContext) {
	pendingAutoCompact = request;
	debug("auto_compact_queued", request);
	notify(ctx, `${EXTENSION_NAME}: will compact after current agent run (${request.reason})`);
}

function shouldResumeAfterCompaction(request: PendingAutoCompact): boolean {
	// If the last assistant response ended for a non-final reason (for example
	// max_tokens/length), compaction should not leave the user with a stalled agent.
	// Tool-use turns normally produce later assistant messages before agent_end;
	// the pending request is overwritten by the latest usage sample.
	return Boolean(request.assistantStopReason && request.assistantStopReason !== "stop");
}

async function runPendingAutoCompaction(pi: ExtensionAPI, ctx: ExtensionContext, source: string) {
	if (!pendingAutoCompact || autoCompactionInFlight) return;
	const request = pendingAutoCompact;
	pendingAutoCompact = undefined;
	autoCompactionInFlight = true;
	debug("auto_compact_start", { source, key: request.key, reason: request.reason });
	try {
		const result = await triggerCompaction(ctx, request.reason, request.customInstructions);
		if (result && shouldResumeAfterCompaction(request)) {
			const prompt = [
				`${EXTENSION_NAME}: compaction completed after assistant stopReason=${request.assistantStopReason}.`,
				"Continue the interrupted task from the compaction summary and kept recent context.",
				"Do not ask for confirmation; proceed with the next concrete step unless the task is already complete.",
			].join(" ");
			debug("auto_resume_after_compact", { key: request.key, stopReason: request.assistantStopReason });
			notify(ctx, `${EXTENSION_NAME}: resuming after compaction`);
			setTimeout(() => pi.sendUserMessage(prompt), 100);
		}
	} finally {
		autoCompactionInFlight = false;
	}
}

export default function contextZipExtension(pi: ExtensionAPI) {
	pi.on("message_end", (event, ctx) => {
		const contextWindow = ctx.model?.contextWindow ?? 0;
		const message = event.message as { role?: string; stopReason?: string; usage?: UsageLike };
		if (message.role !== "assistant") return;
		if (message.stopReason === "aborted" || message.stopReason === "error") return;

		const tokens = usageTokens(message.usage);
		const usage =
			tokens > 0 && contextWindow > 0
				? { tokens, contextWindow, percent: (tokens / contextWindow) * 100 }
				: ctx.getContextUsage();
		debug("message_end_usage", {
			role: message.role,
			stopReason: message.stopReason,
			tokens: usage?.tokens ?? null,
			contextWindow: usage?.contextWindow ?? null,
			percent: usage?.percent ?? null,
			session: ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId(),
			idle: ctx.isIdle(),
		});
		if (!usage || usage.percent === null || usage.tokens === null) return;
		if (usage.percent < AUTO_COMPACT_THRESHOLD_PERCENT) return;

		const key = `${ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId()}:${usage.tokens}`;
		if (key === lastAutoCompactKey || pendingAutoCompact?.key === key) return;
		lastAutoCompactKey = key;

		const reason = `${usage.percent.toFixed(1)}% context >= ${AUTO_COMPACT_THRESHOLD_PERCENT}%`;
		queueAutoCompaction(
			{
				key,
				reason,
				customInstructions: `${EXTENSION_NAME}: automatic compaction at ${AUTO_COMPACT_THRESHOLD_PERCENT}% context. Preserve all critical facts and exact identifiers.`,
				assistantStopReason: message.stopReason,
				usage: {
					tokens: usage.tokens,
					contextWindow: usage.contextWindow,
					percent: usage.percent,
				},
				queuedAt: new Date().toISOString(),
			},
			ctx,
		);

		// Do not compact immediately from message_end: assistant messages with
		// stopReason=toolUse are followed by tool execution and more turns. The old
		// behavior compacted here via setTimeout(0), which aborted that in-flight run
		// and left the agent parked after the compaction banner. Wait for agent_end so
		// the current run can finish naturally, then compact before the next prompt.
		if (ctx.isIdle()) {
			setTimeout(() => {
				void runPendingAutoCompaction(pi, ctx, "message_end_idle");
			}, 0);
		}
	});

	pi.on("agent_end", (_event, ctx) => {
		// Do not await compaction inside agent_end. Pi's Agent only becomes idle
		// after all agent_end listeners settle; ctx.compact() waits for idle before
		// compacting, so awaiting it here would deadlock. Schedule the work for the
		// next macrotask, after the current run has fully finished.
		setTimeout(() => {
			void runPendingAutoCompaction(pi, ctx, "agent_end");
		}, 0);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, customInstructions, signal } = event;
		const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, previousSummary } = preparation;
		let effectiveMessagesToSummarize: unknown[] = messagesToSummarize;
		let effectiveTurnPrefixMessages: unknown[] = turnPrefixMessages;
		let effectiveFirstKeptEntryId = firstKeptEntryId;
		let effectiveIsSplitTurn = preparation.isSplitTurn;
		let fileOps = preparation.fileOps as FileOps;
		let allMessages = [...effectiveMessagesToSummarize, ...effectiveTurnPrefixMessages];

		if (allMessages.length === 0) {
			const fallback = fallbackOversizedTurn(branchEntries as BranchEntryLike[]);
			if (!fallback) {
				notify(ctx, `${EXTENSION_NAME}: no discardable messages in compaction preparation`, "warning");
				return { cancel: true };
			}
			effectiveMessagesToSummarize = fallback.messages;
			effectiveTurnPrefixMessages = [];
			effectiveFirstKeptEntryId = fallback.firstKeptEntryId;
			effectiveIsSplitTurn = false;
			fileOps = {};
			allMessages = [...effectiveMessagesToSummarize, ...effectiveTurnPrefixMessages];
			debug("fallback_oversized_turn", {
				messages: allMessages.length,
				firstKeptEntryId: effectiveFirstKeptEntryId,
			});
		}

		if (!ctx.model) {
			notify(ctx, `${EXTENSION_NAME}: no active model, using default compaction`, "warning");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok) {
			notify(ctx, `${EXTENSION_NAME}: compaction auth failed: ${auth.error}`, "warning");
			return;
		}
		if (!auth.apiKey) {
			notify(ctx, `${EXTENSION_NAME}: no API key for ${ctx.model.provider}, using default compaction`, "warning");
			return;
		}

		const conversationText = serializeConversation(convertToLlm(allMessages as Parameters<typeof convertToLlm>[0]));
		const { readFiles, modifiedFiles } = fileLists(fileOps);
		const sources = sourceEntryIds(branchEntries, effectiveFirstKeptEntryId);
		const details: ContextZipDetails = {
			extension: EXTENSION_NAME,
			version: SUMMARY_SCHEMA_VERSION,
			createdAt: new Date().toISOString(),
			triggerThresholdPercent: AUTO_COMPACT_THRESHOLD_PERCENT,
			model: {
				provider: ctx.model.provider,
				id: ctx.model.id,
				name: ctx.model.name,
			},
			customInstructions,
			firstKeptEntryId: effectiveFirstKeptEntryId,
			tokensBefore,
			summarizedMessageCount: effectiveMessagesToSummarize.length,
			turnPrefixMessageCount: effectiveTurnPrefixMessages.length,
			isSplitTurn: effectiveIsSplitTurn,
			readFiles,
			modifiedFiles,
			...sources,
			previousSummaryIncluded: Boolean(previousSummary),
			conversationChars: conversationText.length,
		};

		notify(
			ctx,
			`${EXTENSION_NAME}: summarizing ${allMessages.length} messages from ${tokensBefore.toLocaleString()} tokens`,
		);

		const prompt = buildPrompt({ conversationText, previousSummary, customInstructions, details });

		try {
			const response = await complete(
				ctx.model,
				{
					systemPrompt:
						"You are a loss-minimizing context compression system. Summarize, do not continue the conversation.",
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: prompt }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					maxTokens: 12_000,
					onPayload: (payload) => {
						if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
						const record = payload as Record<string, unknown>;
						if (typeof record.instructions === "string" && record.instructions.trim()) return undefined;
						return {
							...record,
							instructions:
								"You are a loss-minimizing context compression system. Summarize, do not continue the conversation.",
						};
					},
					signal,
				},
			);

			const summary = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim();

			if (!summary) {
				if (!signal.aborted) notify(ctx, `${EXTENSION_NAME}: empty summary, using default compaction`, "warning");
				return;
			}

			return {
				compaction: {
					summary,
					firstKeptEntryId: effectiveFirstKeptEntryId,
					tokensBefore,
					details,
				},
			};
		} catch (error) {
			if (!signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `${EXTENSION_NAME}: compaction failed, using default: ${message}`, "warning");
			}
			return;
		}
	});

	pi.on("session_compact", (event, ctx) => {
		// If another compaction path ran first, do not keep a stale deferred request
		// around to compact the freshly compacted session again.
		pendingAutoCompact = undefined;
		const details = event.compactionEntry.details as Partial<ContextZipDetails> | undefined;
		if (details?.extension === EXTENSION_NAME) {
			notify(ctx, `${EXTENSION_NAME}: summary saved with ${details.sourceEntryIds?.length ?? 0} source ids`);
		}
	});

	pi.registerCommand("context-zip-status", {
		description: "Show context-zip compaction settings and current context usage",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const usageText = usage
				? `${usage.tokens?.toLocaleString() ?? "unknown"} / ${usage.contextWindow.toLocaleString()} tokens (${usage.percent?.toFixed(1) ?? "unknown"}%)`
				: "unknown";
			notify(
				ctx,
				[
					`${EXTENSION_NAME} enabled`,
					`Auto threshold: ${AUTO_COMPACT_THRESHOLD_PERCENT}%`,
					`Current usage: ${usageText}`,
					`Session: ${ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId()}`,
				].join(" | "),
			);
		},
	});

	pi.registerCommand("context-zip-compact", {
		description: "Trigger context-zip compaction immediately",
		handler: async (args, ctx) => {
			pendingAutoCompact = undefined;
			await triggerCompaction(ctx, "manual command", args.trim() || `${EXTENSION_NAME}: manual compaction test`);
		},
	});
}
