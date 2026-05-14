import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";

type ProcessResult = {
	command: string;
	args: string[];
	cwd: string;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	durationMs: number;
};

type ContextZipPin = { kind: string; text: string; source: string };
type ContextZipEvidence = { kind: string; text: string; source: string; keep: "verbatim" };
type ContextZipArchiveItem = { id: string; kind: string; summary: string; path: string; tokenEstimate: number; retrievalTerms: string[] };
type ContextZipGroup = {
	id: string;
	entryIds: string[];
	kind: string;
	start: string;
	end: string;
	text: string;
	tokenEstimate: number;
	important: boolean;
};
type ContextZipStateLedger = {
	goal: string;
	constraints: string[];
	decisions: string[];
	filesChanged: string[];
	validation: string[];
	openQuestions: string[];
	nextActions: string[];
};
type ContextZipArtifact = {
	version: "context-zip-v1";
	id: string;
	createdAt: string;
	cwd: string;
	customInstructions?: string;
	contextUsage: { tokens: number; contextWindow?: number; percent?: number | null };
	tokenStats: { before: number; afterEstimate: number; compressionRatio: number };
	firstKeptEntryId: string;
	pins: ContextZipPin[];
	hotTail: Array<{ entryIds: string[]; text: string; tokenEstimate: number }>;
	stateLedger: ContextZipStateLedger;
	verbatimEvidence: ContextZipEvidence[];
	narrativeSummary: string;
	archiveIndex: ContextZipArchiveItem[];
	integrityChecks: {
		userConstraintsPreserved: boolean;
		toolResultsGrouped: boolean;
		pathsPreserved: boolean;
		nextActionPresent: boolean;
	};
	compactionSummary: string;
	artifactPath: string;
	artifactRelPath: string;
	markdownPath: string;
	markdownRelPath: string;
	summarizerArtifact?: string;
};

type ContextZipOptions = {
	customInstructions?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	contextWindow?: number;
	percent?: number | null;
	signal?: AbortSignal;
	onUpdate?: (message: string) => void;
};

type ContextZipSummarizerRun = {
	runId: string;
	zipId: string;
	role: "context-zip-summarizer";
	startedAt: string;
	finishedAt: string;
	durationMs: number;
	process: ProcessResult;
	parsedOutput?: unknown;
	parseError?: string;
	artifactPath: string;
	artifactRelPath: string;
};

const ContextZipToolSchema = Type.Object({
	customInstructions: Type.Optional(Type.String({ description: "Optional preservation instructions for Context ZIP." })),
	apply: Type.Optional(Type.Boolean({ description: "Append a compaction entry after creating the zip. Defaults false." })),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asStringArray(value: unknown): string[] {
	if (typeof value === "string" && value.trim()) return [value.trim()];
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim()] : [])).slice(0, 20);
}

function truncateText(text: string, maxChars = 80_000): string {
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.35);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n\n[... truncated ${text.length - maxChars} chars ...]\n\n${text.slice(-tail)}`;
}

function tokenizeCommandArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | "" = "";
	for (let i = 0; i < input.length; i += 1) {
		const char = input[i];
		if (char === "\\" && i + 1 < input.length) {
			current += input[i + 1];
			i += 1;
			continue;
		}
		if ((char === "'" || char === '"') && !quote) {
			quote = char;
			continue;
		}
		if (quote && char === quote) {
			quote = "";
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

function contentToPlainText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const item = part as Record<string, unknown>;
			if (item.type === "text") return String(item.text ?? "");
			if (item.type === "thinking") return `[thinking] ${String(item.thinking ?? "")}`;
			if (item.type === "toolCall") return `[toolCall ${String(item.name ?? "tool")}] ${truncateText(JSON.stringify(item.arguments ?? {}), 1200)}`;
			if (item.type === "image") return "[image]";
			return JSON.stringify(item);
		})
		.filter(Boolean)
		.join("\n");
}

function estimateContextTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function entryTimestamp(entry: Record<string, unknown>): string {
	return String(entry.timestamp ?? "");
}

function entryId(entry: Record<string, unknown>, fallback: string): string {
	return String(entry.id ?? fallback);
}

function entryToContextText(entry: Record<string, unknown>, index: number): { id: string; role: string; text: string; important: boolean } {
	const id = entryId(entry, `entry-${index}`);
	const type = String(entry.type ?? "unknown");
	if (type === "message") {
		const message = asRecord(entry.message) ?? {};
		const role = String(message.role ?? "message");
		if (role === "assistant") {
			const usage = asRecord(message.usage);
			const usageText = usage ? `\n[usage] ${JSON.stringify(usage)}` : "";
			return { id, role, text: `[assistant]\n${contentToPlainText(message.content)}${usageText}`, important: false };
		}
		if (role === "toolResult") {
			const toolName = String(message.toolName ?? "tool");
			const isError = Boolean(message.isError);
			const details = message.details ? `\n[details] ${truncateText(JSON.stringify(message.details), 2000)}` : "";
			return {
				id,
				role,
				text: `[toolResult:${toolName}${isError ? ":error" : ""}]\n${contentToPlainText(message.content)}${details}`,
				important: isError,
			};
		}
		if (role === "bashExecution") {
			const command = String(message.command ?? "");
			const output = String(message.output ?? "");
			const exitCode = message.exitCode ?? null;
			return { id, role, text: `[bash exit=${exitCode}] ${command}\n${truncateText(output, 8000)}`, important: exitCode !== 0 };
		}
		return { id, role, text: `[${role}]\n${contentToPlainText(message.content)}`, important: role === "user" };
	}
	if (type === "custom_message") {
		return { id, role: "custom", text: `[custom:${String(entry.customType ?? "unknown")}]\n${contentToPlainText(entry.content)}`, important: true };
	}
	if (type === "compaction") {
		return { id, role: "compaction", text: `[previous compaction]\n${String(entry.summary ?? "")}`, important: true };
	}
	if (type === "branch_summary") {
		return { id, role: "branch_summary", text: `[branch summary]\n${String(entry.summary ?? "")}`, important: true };
	}
	return { id, role: type, text: `[${type}] ${truncateText(JSON.stringify(entry), 4000)}`, important: false };
}

function groupContextEntries(entries: Array<Record<string, unknown>>): ContextZipGroup[] {
	const groups: ContextZipGroup[] = [];
	let current: Array<{ entry: Record<string, unknown>; text: ReturnType<typeof entryToContextText> }> = [];
	const flush = () => {
		if (!current.length) return;
		const text = current.map((item) => item.text.text).join("\n\n");
		const ids = current.map((item, index) => entryId(item.entry, `entry-${groups.length}-${index}`));
		const roles = new Set(current.map((item) => item.text.role));
		const kind = roles.has("user") ? "turn" : roles.has("toolResult") ? "tool-observation" : roles.has("compaction") ? "previous-compaction" : "session-fragment";
		groups.push({
			id: `g${groups.length + 1}`,
			entryIds: ids,
			kind,
			start: entryTimestamp(current[0].entry),
			end: entryTimestamp(current[current.length - 1].entry),
			text,
			tokenEstimate: estimateContextTokens(text),
			important: current.some((item) => item.text.important) || /\b(error|failed|exception|todo|next|decision|requirement|запрещ|нельзя|только|must|should)\b/i.test(text),
		});
		current = [];
	};
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const text = entryToContextText(entry, index);
		if ((text.role === "user" || text.role === "custom") && current.length) flush();
		current.push({ entry, text });
	}
	flush();
	return groups;
}

function extractContextPins(groups: ContextZipGroup[], projectRules: string): ContextZipPin[] {
	const pins: ContextZipPin[] = [];
	if (projectRules.trim()) {
		pins.push({ kind: "project_rules", text: truncateText(projectRules.trim(), 6000), source: "AGENTS.md" });
	}
	for (const group of groups) {
		const lines = group.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		for (const line of lines) {
			if (/\b(must|never|required|only|do not|don't|should|нельзя|запрещ|только|обязательно|должен|сделай|важно)\b/i.test(line)) {
				pins.push({ kind: "constraint", text: truncateText(line, 800), source: group.id });
			}
			if (pins.length >= 24) return pins;
		}
	}
	return pins;
}

function extractContextEvidence(groups: ContextZipGroup[]): ContextZipEvidence[] {
	const evidence: ContextZipEvidence[] = [];
	const seen = new Set<string>();
	const counts = new Map<string, number>();
	const limits: Record<string, number> = { file: 40, url: 20, critical_line: 30 };
	const add = (kind: string, text: string, source: string) => {
		const compact = text
			.replace(/^\[[^\]]+\]\s*/, "")
			.replace(/\bD\d+\b/g, "D#")
			.replace(/\s+/g, " ")
			.trim();
		if (!compact || (counts.get(kind) ?? 0) >= (limits[kind] ?? 20) || seen.has(`${kind}:${compact}`)) return;
		seen.add(`${kind}:${compact}`);
		counts.set(kind, (counts.get(kind) ?? 0) + 1);
		evidence.push({ kind, text: truncateText(compact, 900), source, keep: "verbatim" });
	};
	for (const group of groups) {
		for (const match of group.text.matchAll(/(?:^|\s)([\w./-]+\.(?:ts|tsx|js|jsx|json|md|qnt|py|go|rs|java|yml|yaml|toml|html|css|sh|txt|lock))(?:\b|$)/g)) {
			add("file", match[1], group.id);
		}
		for (const match of group.text.matchAll(/https?:\/\/[^\s)\]"']+/g)) {
			add("url", match[0], group.id);
		}
		for (const line of group.text.split(/\r?\n/)) {
			if (/\b(exit=\d+|error|failed|exception|validation|test|command|decision|next action)\b/i.test(line)) add("critical_line", line, group.id);
		}
		if (evidence.length >= 90) break;
	}
	return evidence;
}

function selectHotTail(groups: ContextZipGroup[], totalTokens: number): ContextZipGroup[] {
	const target = Math.max(3000, Math.min(20_000, Math.ceil(totalTokens * 0.18)));
	const selected: ContextZipGroup[] = [];
	let tokens = 0;
	for (let i = groups.length - 1; i >= 0; i -= 1) {
		selected.unshift(groups[i]);
		tokens += groups[i].tokenEstimate;
		if (tokens >= target) break;
	}
	return selected;
}

function retrievalTerms(text: string): string[] {
	return Array.from(new Set(text.toLowerCase().split(/[^a-zа-я0-9_.-]+/i).filter((part) => part.length >= 4))).slice(0, 16);
}

async function archiveContextGroups(parentCwd: string, zipId: string, groups: ContextZipGroup[], hotTailIds: Set<string>): Promise<ContextZipArchiveItem[]> {
	const archiveDir = path.join(parentCwd, ".pi", "context-archive");
	await mkdir(archiveDir, { recursive: true });
	const items: ContextZipArchiveItem[] = [];
	for (const group of groups) {
		if (group.tokenEstimate < 500 || (hotTailIds.has(group.id) && group.tokenEstimate < 2500)) continue;
		const archiveId = `${zipId}-${group.id}`;
		const archivePath = path.join(archiveDir, `${archiveId}.txt`);
		await writeFile(archivePath, group.text, "utf8");
		items.push({
			id: archiveId,
			kind: group.kind,
			summary: truncateText(group.text.replace(/\s+/g, " "), 500),
			path: path.relative(parentCwd, archivePath),
			tokenEstimate: group.tokenEstimate,
			retrievalTerms: retrievalTerms(group.text),
		});
		if (items.length >= 80) break;
	}
	return items;
}

function fallbackStateLedger(groups: ContextZipGroup[], pins: ContextZipPin[], evidence: ContextZipEvidence[]): ContextZipStateLedger {
	const latestImportant = [...groups].reverse().find((group) => group.important)?.text ?? groups.at(-1)?.text ?? "";
	return {
		goal: truncateText(latestImportant.replace(/\s+/g, " "), 800),
		constraints: pins.slice(0, 12).map((pin) => pin.text),
		decisions: evidence.filter((item) => item.kind === "critical_line" && /decision/i.test(item.text)).slice(0, 10).map((item) => item.text),
		filesChanged: evidence.filter((item) => item.kind === "file").slice(0, 20).map((item) => item.text),
		validation: evidence.filter((item) => /test|validation|exit=/i.test(item.text)).slice(0, 12).map((item) => item.text),
		openQuestions: [],
		nextActions: ["Continue from the latest user request using pinned constraints, verbatim evidence, and the hot tail."],
	};
}

function tailText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `[... Context ZIP hot tail: omitted ${text.length - maxChars} earlier chars from this large group; full text is in archive ...]\n${text.slice(-maxChars)}`;
}

function buildContextZipSummaryTask(payload: Record<string, unknown>, customInstructions?: string): string {
	return [
		"You are the Context ZIP summarizer/verifier for a coding-agent session.",
		"Build an exact-first continuation summary. Do not invent facts. Prefer structured state over prose.",
		"Use pins and verbatimEvidence as source of truth. The hotTail is recent context that will be kept separately.",
		customInstructions ? `User preservation instructions: ${customInstructions}` : "",
		"Return ONLY valid JSON with this shape:",
		`{"narrativeSummary":"short continuation summary","stateLedger":{"goal":"current user goal","constraints":["..."],"decisions":["..."],"filesChanged":["..."],"validation":["..."],"openQuestions":["..."],"nextActions":["..."]},"integrityNotes":["lost/weak areas or empty"]}`,
		"",
		"Input JSON:",
		truncateText(JSON.stringify(payload, null, 2), 120_000),
	].filter(Boolean).join("\n");
}

function coerceStringList(value: unknown, max = 20): string[] {
	return asStringArray(value).map((item) => truncateText(item, 1200)).slice(0, max);
}

function coerceContextZipSummarizerOutput(parsed: unknown, fallback: ContextZipStateLedger): { narrativeSummary: string; stateLedger: ContextZipStateLedger; integrityNotes: string[] } {
	const object = asRecord(parsed);
	if (!object) return { narrativeSummary: fallback.goal, stateLedger: fallback, integrityNotes: ["Context ZIP summarizer did not return parseable JSON; deterministic fallback used."] };
	const rawLedger = asRecord(object.stateLedger) ?? {};
	const stateLedger: ContextZipStateLedger = {
		goal: truncateText(String(rawLedger.goal ?? fallback.goal ?? "").trim(), 1200),
		constraints: coerceStringList(rawLedger.constraints ?? fallback.constraints),
		decisions: coerceStringList(rawLedger.decisions ?? fallback.decisions),
		filesChanged: coerceStringList(rawLedger.filesChanged ?? rawLedger.files_changed ?? fallback.filesChanged),
		validation: coerceStringList(rawLedger.validation ?? fallback.validation),
		openQuestions: coerceStringList(rawLedger.openQuestions ?? rawLedger.open_questions ?? fallback.openQuestions),
		nextActions: coerceStringList(rawLedger.nextActions ?? rawLedger.next_actions ?? fallback.nextActions),
	};
	if (!stateLedger.nextActions.length) stateLedger.nextActions = fallback.nextActions;
	return {
		narrativeSummary: truncateText(String(object.narrativeSummary ?? object.summary ?? fallback.goal).trim(), 4000),
		stateLedger,
		integrityNotes: coerceStringList(object.integrityNotes ?? object.integrity_notes, 12),
	};
}

function parseJsonOutput(text: string): { parsed?: unknown; error?: string } {
	const trimmed = text.trim();
	if (!trimmed) return { error: "empty output" };
	const candidates = [trimmed];
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence?.[1]) candidates.push(fence[1].trim());
	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			return { parsed: JSON.parse(candidate) };
		} catch {
			// try next
		}
	}
	return { error: "could not parse JSON output" };
}

function readEnvInteger(name: string, fallback: number, min: number, max: number): number {
	const parsed = Number(process.env[name]);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.max(min, Math.min(Math.floor(parsed), max));
}

async function runProcess(
	command: string,
	args: string[],
	options: { cwd: string; stdin: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessResult> {
	const started = Date.now();
	return await new Promise<ProcessResult>((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;
		let timeout: ReturnType<typeof setTimeout>;

		const finish = (exitCode: number | null, signal: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abortHandler);
			resolve({
				command,
				args,
				cwd: options.cwd,
				stdout: truncateText(stdout),
				stderr: truncateText(stderr, 40_000),
				exitCode,
				signal,
				timedOut,
				durationMs: Date.now() - started,
			});
		};

		const killChild = () => {
			try {
				child.kill("SIGTERM");
			} catch {
				// ignore
			}
			setTimeout(() => {
				if (!settled) {
					try {
						child.kill("SIGKILL");
					} catch {
						// ignore
					}
				}
			}, 2000).unref?.();
		};

		const abortHandler = () => {
			stderr += "\n[Context ZIP] Aborted by parent signal.";
			killChild();
		};

		timeout = setTimeout(() => {
			timedOut = true;
			stderr += `\n[Context ZIP] Timed out after ${Math.round(options.timeoutMs / 1000)}s.`;
			killChild();
		}, options.timeoutMs);
		timeout.unref?.();

		options.signal?.addEventListener("abort", abortHandler, { once: true });

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			stderr += `\n[Context ZIP] Failed to spawn ${command}: ${error.message}`;
			finish(null, null);
		});
		child.on("close", (code, signal) => finish(code, signal));

		child.stdin?.end(options.stdin);
	});
}

async function writeSummarizerArtifact(
	parentCwd: string,
	result: Omit<ContextZipSummarizerRun, "artifactPath" | "artifactRelPath">,
): Promise<ContextZipSummarizerRun> {
	const dir = path.join(parentCwd, ".pi", "context-zips");
	await mkdir(dir, { recursive: true });
	const artifactPath = path.join(dir, `${result.zipId}-summarizer.json`);
	await writeFile(artifactPath, JSON.stringify({ ...result, artifactPath, artifactRelPath: path.relative(parentCwd, artifactPath) }, null, 2), "utf8");
	return { ...result, artifactPath, artifactRelPath: path.relative(parentCwd, artifactPath) };
}

async function runContextZipSummarizer(
	parentCwd: string,
	zipId: string,
	task: string,
	options: { signal?: AbortSignal; onUpdate?: (message: string) => void },
): Promise<ContextZipSummarizerRun> {
	const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-context-zip-summarizer-${randomUUID().slice(0, 8)}`;
	const startedAt = new Date().toISOString();
	const piCommand = process.env.PI_CONTEXT_ZIP_COMMAND || process.env.PI_COMMAND || "pi";
	const args = ["-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools"];
	const model = process.env.PI_CONTEXT_ZIP_MODEL?.trim();
	const thinking = process.env.PI_CONTEXT_ZIP_THINKING?.trim();
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	args.push("Create a Context ZIP continuation summary from stdin. Return only the requested JSON.");

	options.onUpdate?.("summarizing with child pi");
	const processResult = await runProcess(piCommand, args, {
		cwd: parentCwd,
		stdin: task,
		timeoutMs: readEnvInteger("PI_CONTEXT_ZIP_TIMEOUT_SECONDS", 900, 30, 1800) * 1000,
		signal: options.signal,
	});
	const parseResult = parseJsonOutput(processResult.stdout);
	const finishedAt = new Date().toISOString();
	return await writeSummarizerArtifact(parentCwd, {
		runId,
		zipId,
		role: "context-zip-summarizer",
		startedAt,
		finishedAt,
		durationMs: processResult.durationMs,
		process: processResult,
		parsedOutput: parseResult.parsed,
		parseError: parseResult.error,
	});
}

function formatContextZipCompactionSummary(zip: Omit<ContextZipArtifact, "artifactPath" | "artifactRelPath" | "markdownPath" | "markdownRelPath">): string {
	const ledger = zip.stateLedger;
	return [
		"# Context ZIP v1",
		"",
		`Created: ${zip.createdAt}`,
		`Artifact: .pi/context-zips/${zip.id}.json`,
		`Tokens: before≈${zip.tokenStats.before}, after≈${zip.tokenStats.afterEstimate}, compression≈${Math.round(zip.tokenStats.compressionRatio * 100)}%`,
		"",
		"## Narrative summary",
		zip.narrativeSummary || "No narrative summary.",
		"",
		"## Goal",
		ledger.goal || "Unknown.",
		"",
		"## Pinned constraints",
		...(ledger.constraints.length ? ledger.constraints.map((item) => `- ${item}`) : zip.pins.slice(0, 12).map((pin) => `- ${pin.text}`)),
		"",
		"## Key decisions",
		...(ledger.decisions.length ? ledger.decisions.map((item) => `- ${item}`) : ["- None captured."]),
		"",
		"## Files / exact evidence",
		...(ledger.filesChanged.length ? ledger.filesChanged.map((item) => `- ${item}`) : zip.verbatimEvidence.filter((item) => item.kind === "file").slice(0, 20).map((item) => `- ${item.text}`)),
		"",
		"## Validation / failures",
		...(ledger.validation.length ? ledger.validation.map((item) => `- ${item}`) : ["- None captured."]),
		"",
		"## Next actions",
		...(ledger.nextActions.length ? ledger.nextActions.map((item, index) => `${index + 1}. ${item}`) : ["1. Continue from the latest user request."]),
		"",
		"## Archive index",
		...(zip.archiveIndex.length ? zip.archiveIndex.slice(0, 30).map((item) => `- ${item.id}: ${item.path} (${item.tokenEstimate} tokens)`) : ["- No archived groups."]),
	].join("\n");
}

function formatContextZipMarkdown(zip: ContextZipArtifact): string {
	return [
		"# Context ZIP created",
		"",
		`- id: ${zip.id}`,
		`- artifact: ${zip.artifactRelPath}`,
		`- markdown: ${zip.markdownRelPath}`,
		`- tokens before: ${zip.tokenStats.before}`,
		`- tokens after estimate: ${zip.tokenStats.afterEstimate}`,
		`- compression ratio: ${(zip.tokenStats.compressionRatio * 100).toFixed(1)}%`,
		`- context percent: ${zip.contextUsage.percent === null || zip.contextUsage.percent === undefined ? "unknown" : `${zip.contextUsage.percent.toFixed(1)}%`}`,
		`- first kept entry: ${zip.firstKeptEntryId}`,
		`- pins: ${zip.pins.length}`,
		`- evidence: ${zip.verbatimEvidence.length}`,
		`- archive items: ${zip.archiveIndex.length}`,
		`- summarizer artifact: ${zip.summarizerArtifact ?? "none"}`,
		"",
		"## Next actions",
		...(zip.stateLedger.nextActions.length ? zip.stateLedger.nextActions.map((item, index) => `${index + 1}. ${item}`) : ["1. Continue from latest request."]),
	].join("\n");
}

async function readProjectRules(parentCwd: string): Promise<string> {
	const agentsPath = path.join(parentCwd, "AGENTS.md");
	if (!existsSync(agentsPath)) return "";
	try {
		return await readFile(agentsPath, "utf8");
	} catch {
		return "";
	}
}

async function createContextZip(parentCwd: string, entries: Array<Record<string, unknown>>, options: ContextZipOptions = {}): Promise<ContextZipArtifact> {
	const createdAt = new Date().toISOString();
	const zipId = `${createdAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
	options.onUpdate?.("grouping session context");
	const groups = groupContextEntries(entries);
	const allText = groups.map((group) => group.text).join("\n\n");
	const estimatedBefore = options.tokensBefore ?? estimateContextTokens(allText);
	const hotTailGroups = selectHotTail(groups, estimatedBefore);
	const hotTailIds = new Set(hotTailGroups.map((group) => group.id));
	const firstHotTailGroup = hotTailGroups[0];
	const firstKeptEntryId =
		options.firstKeptEntryId ??
		(firstHotTailGroup && firstHotTailGroup.tokenEstimate > Math.max(3000, estimatedBefore * 0.4)
			? firstHotTailGroup.entryIds.at(-1)
			: firstHotTailGroup?.entryIds[0]) ??
		groups.at(-1)?.entryIds.at(-1) ??
		"";

	const projectRules = await readProjectRules(parentCwd);
	const pins = extractContextPins(groups, projectRules);
	const verbatimEvidence = extractContextEvidence(groups);
	options.onUpdate?.("archiving older context groups");
	const archiveIndex = await archiveContextGroups(parentCwd, zipId, groups, hotTailIds);
	const fallbackLedger = fallbackStateLedger(groups, pins, verbatimEvidence);
	const summaryPayload = {
		customInstructions: options.customInstructions,
		pins,
		verbatimEvidence: verbatimEvidence.slice(0, 60),
		hotTail: hotTailGroups.map((group) => ({ id: group.id, entryIds: group.entryIds, kind: group.kind, text: tailText(group.text, 5000) })),
		archiveIndex: archiveIndex.slice(0, 40),
		groupStats: groups.map((group) => ({
			id: group.id,
			kind: group.kind,
			tokens: group.tokenEstimate,
			important: group.important,
			preview: truncateText(group.text.replace(/\s+/g, " "), 350),
		})),
	};
	const summarizerTask = buildContextZipSummaryTask(summaryPayload, options.customInstructions);
	const summarizerRun = await runContextZipSummarizer(parentCwd, zipId, summarizerTask, { signal: options.signal, onUpdate: options.onUpdate });
	const coerce = coerceContextZipSummarizerOutput(summarizerRun.parsedOutput, fallbackLedger);
	const hotTail = hotTailGroups.map((group) => {
		const text = tailText(group.text, 8000);
		return { entryIds: group.entryIds, text, tokenEstimate: estimateContextTokens(text) };
	});
	const afterEstimate = estimateContextTokens([
		coerce.narrativeSummary,
		JSON.stringify(coerce.stateLedger),
		JSON.stringify(pins),
		JSON.stringify(verbatimEvidence),
		hotTail.map((item) => item.text).join("\n"),
		JSON.stringify(archiveIndex.map((item) => ({ id: item.id, summary: item.summary, path: item.path }))),
	].join("\n"));
	const partial: Omit<ContextZipArtifact, "artifactPath" | "artifactRelPath" | "markdownPath" | "markdownRelPath" | "compactionSummary"> = {
		version: "context-zip-v1",
		id: zipId,
		createdAt,
		cwd: parentCwd,
		customInstructions: options.customInstructions,
		contextUsage: { tokens: estimatedBefore, contextWindow: options.contextWindow, percent: options.percent },
		tokenStats: {
			before: estimatedBefore,
			afterEstimate,
			compressionRatio: estimatedBefore > 0 ? Math.max(0, 1 - afterEstimate / estimatedBefore) : 0,
		},
		firstKeptEntryId,
		pins,
		hotTail,
		stateLedger: coerce.stateLedger,
		verbatimEvidence,
		narrativeSummary: coerce.narrativeSummary,
		archiveIndex,
		integrityChecks: {
			userConstraintsPreserved: pins.length > 0,
			toolResultsGrouped: true,
			pathsPreserved: verbatimEvidence.some((item) => item.kind === "file") || !allText.match(/\.[tj]sx?|\.md|\.json/),
			nextActionPresent: coerce.stateLedger.nextActions.length > 0,
		},
		summarizerArtifact: summarizerRun.artifactRelPath,
	};
	const compactionSummary = formatContextZipCompactionSummary({ ...partial, compactionSummary: "" });
	const dir = path.join(parentCwd, ".pi", "context-zips");
	await mkdir(dir, { recursive: true });
	const artifactPath = path.join(dir, `${zipId}.json`);
	const markdownPath = path.join(dir, `${zipId}.md`);
	const zip: ContextZipArtifact = {
		...partial,
		compactionSummary,
		artifactPath,
		artifactRelPath: path.relative(parentCwd, artifactPath),
		markdownPath,
		markdownRelPath: path.relative(parentCwd, markdownPath),
	};
	await writeFile(artifactPath, JSON.stringify(zip, null, 2), "utf8");
	await writeFile(markdownPath, formatContextZipMarkdown(zip), "utf8");
	return zip;
}

function parseContextZipArgs(args: string): { apply: boolean; customInstructions?: string } {
	const tokens = tokenizeCommandArgs(args.trim());
	let apply = false;
	const rest: string[] = [];
	for (const token of tokens) {
		if (token === "--apply") apply = true;
		else rest.push(token);
	}
	return { apply, customInstructions: rest.join(" ").trim() || undefined };
}

async function createContextZipFromExtensionContext(ctx: {
	cwd: string;
	sessionManager: { getBranch(): unknown[] };
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	signal?: AbortSignal;
}, options: ContextZipOptions = {}): Promise<ContextZipArtifact> {
	const usage = ctx.getContextUsage();
	const branchEntries = (ctx.sessionManager.getBranch() as Array<Record<string, unknown>>) ?? [];
	return await createContextZip(ctx.cwd, branchEntries, {
		...options,
		tokensBefore: options.tokensBefore ?? (typeof usage?.tokens === "number" ? usage.tokens : undefined),
		contextWindow: options.contextWindow ?? usage?.contextWindow,
		percent: options.percent ?? usage?.percent,
		signal: options.signal ?? ctx.signal,
	});
}

function applyContextZipCompaction(ctx: { sessionManager: unknown }, zip: ContextZipArtifact): string | undefined {
	const manager = ctx.sessionManager as { appendCompaction?: (summary: string, firstKeptEntryId: string, tokensBefore: number, details?: unknown, fromHook?: boolean) => string };
	if (typeof manager.appendCompaction !== "function" || !zip.firstKeptEntryId) return undefined;
	return manager.appendCompaction(
		zip.compactionSummary,
		zip.firstKeptEntryId,
		zip.tokenStats.before,
		{
			kind: "context-zip-v1",
			zipId: zip.id,
			artifact: zip.artifactRelPath,
			markdown: zip.markdownRelPath,
			archiveItems: zip.archiveIndex.length,
			integrityChecks: zip.integrityChecks,
		},
		true,
	);
}

export default function contextZip(pi: ExtensionAPI) {
	pi.registerCommand("context:zip", {
		description: "Create an exact-first Context ZIP for the current session; --apply appends a compaction entry",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const options = parseContextZipArgs(args);
			ctx.ui.notify("Context ZIP started", "info");
			ctx.ui.setStatus("context-zip", "building…");
			try {
				const zip = await createContextZipFromExtensionContext(ctx, {
					customInstructions: options.customInstructions,
					signal: ctx.signal,
					onUpdate: (message) => ctx.ui.setStatus("context-zip", message),
				});
				let compactionEntryId: string | undefined;
				if (options.apply) compactionEntryId = applyContextZipCompaction(ctx, zip);
				const text = [
					formatContextZipMarkdown(zip),
					options.apply ? `\nApplied compaction entry: ${compactionEntryId ?? "not available"}` : "\nRun `/context:zip --apply` to append this as a compaction entry.",
				].join("\n");
				pi.sendMessage({ customType: "context-zip-result", content: text, display: true, details: { zip, compactionEntryId } });
				ctx.ui.notify(`Context ZIP saved: ${zip.artifactRelPath}`, "success");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				pi.sendMessage({ customType: "context-zip-error", content: `# /context:zip failed\n\n${message}`, display: true });
				ctx.ui.notify(`/context:zip failed: ${message}`, "error");
			} finally {
				ctx.ui.setStatus("context-zip", undefined);
			}
		},
	});

	pi.on("session_before_compact", async (event, ctx) => {
		ctx.ui.notify("Context ZIP compaction started", "info");
		ctx.ui.setStatus("context-zip", "building…");
		try {
			const usage = ctx.getContextUsage();
			const zip = await createContextZip(ctx.cwd, event.branchEntries as Array<Record<string, unknown>>, {
				customInstructions: event.customInstructions,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				contextWindow: usage?.contextWindow,
				percent: usage?.percent,
				signal: event.signal,
				onUpdate: (message) => ctx.ui.setStatus("context-zip", message),
			});
			return {
				compaction: {
					summary: zip.compactionSummary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {
						kind: "context-zip-v1",
						zipId: zip.id,
						artifact: zip.artifactRelPath,
						markdown: zip.markdownRelPath,
						archiveItems: zip.archiveIndex.length,
						integrityChecks: zip.integrityChecks,
					},
				},
			};
		} finally {
			ctx.ui.setStatus("context-zip", undefined);
		}
	});

	pi.registerTool({
		name: "context_zip_create",
		label: "Context ZIP create",
		description:
			"Create an exact-first Context ZIP artifact for the current Pi session. Optionally append a compaction entry. Saves .pi/context-zips/*.json and .md plus .pi/context-archive items.",
		promptSnippet: "Create a Context ZIP state ledger, verbatim evidence set, hot tail, and archive index for the current session.",
		promptGuidelines: [
			"Use context_zip_create when the user asks to compact, zip, preserve, or inspect the current session context.",
			"context_zip_create should be validated through real Pi command/tool paths, not direct helper calls.",
		],
		parameters: ContextZipToolSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const typed = params as { customInstructions?: string; apply?: boolean };
			const zip = await createContextZipFromExtensionContext(ctx, {
				customInstructions: typed.customInstructions,
				signal,
				onUpdate: (message) => onUpdate?.({ content: [{ type: "text", text: `Context ZIP: ${message}` }] }),
			});
			let compactionEntryId: string | undefined;
			if (typed.apply) compactionEntryId = applyContextZipCompaction(ctx, zip);
			return {
				content: [{ type: "text", text: `${formatContextZipMarkdown(zip)}${typed.apply ? `\n\nApplied compaction entry: ${compactionEntryId ?? "not available"}` : ""}` }],
				details: { zip, compactionEntryId },
			};
		},
	});
}
