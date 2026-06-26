import { complete } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ChangeUnit, CommitPlan, PlannedCommit, RepoSnapshot, ValidationResult } from "./types.ts";
import { extractJsonCandidate, normalizeSubjectLine, truncateMiddle, uniqueSorted } from "./utils.ts";

const MAX_PROMPT_CHARS = 120_000;
const MAX_PREVIOUS_PLAN_CHARS = 12_000;
const MAX_FEEDBACK_CHARS = 4_000;

export interface PlanCommitsOptions {
	previousPlan?: CommitPlan;
	feedbackHistory?: string[];
}

const SYSTEM_PROMPT = `You are pi-commit-planner, a careful Git commit planning assistant.

Your job is to partition the provided repository changes into the safest reasonable set of commits.

Rules:
- Output JSON only. No markdown fences, no prose before or after the JSON.
- The JSON schema is:
  {
    "summary": string,
    "commits": [
      {
        "message": string,
        "why": string,
        "changes": string[]
      }
    ]
  }
- Write every free-text field in English, including "summary" and every "why" value.
- Every change ID must appear exactly once across all commits.
- Never invent change IDs. Use only the provided IDs, copied exactly.
- Some files are splittable into multiple hunk-level change IDs. Only split where multiple IDs are provided for the same file.
- Prefer fewer commits over risky splitting. If uncertain, collapse changes into one commit.
- If several change IDs from one file are tightly coupled, keep them in the same commit.
- A deleted file plus a new file with similar content may represent a move or rename; keep them together when that seems right.
- Every commit message must use Conventional Commits format: type(scope): subject or type: subject.
- Use a concise imperative English subject with a sensible lowercase type such as feat, fix, refactor, test, docs, chore, perf, build, or ci.
- Keep commit messages on one line and within 72 characters when practical.
- The "why" field should briefly justify the grouping for a human reviewer in English.`;

function buildUnitCatalog(units: ChangeUnit[]): string[] {
	const lines = ["Allowed change IDs (must be covered exactly once):"];
	for (const unit of units) {
		lines.push(`- ${unit.id} | ${unit.path} | ${unit.kind} | ${unit.summary}`);
	}
	return lines;
}

function buildReplanningContext(options?: PlanCommitsOptions): string[] {
	const feedbackHistory = options?.feedbackHistory?.map((feedback) => feedback.trim()).filter(Boolean) ?? [];
	if (!options?.previousPlan && feedbackHistory.length === 0) {
		return [];
	}

	const lines: string[] = [];
	lines.push("This is a replanning round.");
	lines.push("Generate a NEW plan that incorporates the feedback while still covering every change ID exactly once.");
	lines.push("Prefer the latest feedback most strongly, while keeping earlier non-conflicting feedback when possible.");
	lines.push("");

	if (options?.previousPlan) {
		lines.push("Most recent plan to revise:");
		lines.push(truncateMiddle(JSON.stringify(options.previousPlan, null, 2), MAX_PREVIOUS_PLAN_CHARS));
		lines.push("");
	}

	if (feedbackHistory.length > 0) {
		lines.push("User feedback history (oldest to newest):");
		feedbackHistory.forEach((feedback, index) => {
			lines.push(`Feedback ${index + 1}:`);
			lines.push(truncateMiddle(feedback, MAX_FEEDBACK_CHARS));
		});
		lines.push("");
	}

	return lines;
}

function buildPlanningPrompt(snapshot: RepoSnapshot, options?: PlanCommitsOptions): string {
	const lines: string[] = [];
	lines.push("Plan one or more commits for the current repository changes.");
	lines.push("Treat the current staged and unstaged state as implementation detail; plan across ALL current changes.");
	lines.push("Use Conventional Commits for every commit message: `type(scope): subject` or `type: subject`.");
	lines.push("Write the plan summary and every why explanation in English.");
	lines.push("");
	lines.push(...buildReplanningContext(options));
	lines.push(...buildUnitCatalog(snapshot.units));
	lines.push("");

	if (snapshot.recentCommitSubjects.length > 0) {
		lines.push("Recent commit subjects (repository context only; keep Conventional Commits and English explanations):");
		for (const subject of snapshot.recentCommitSubjects) {
			lines.push(`- ${subject}`);
		}
		lines.push("");
	}

	lines.push("Repository changes:");
	let usedChars = lines.join("\n").length;

	for (const file of snapshot.files) {
		const sectionLines: string[] = [];
		sectionLines.push("");
		sectionLines.push(`## ${file.path}`);
		sectionLines.push(`File summary: ${file.summary}`);
		sectionLines.push(`Split mode: ${file.supportsHunkSplit ? "hunk-level" : "whole-file"}`);
		sectionLines.push("Change IDs in this file:");
		for (const unit of file.units) {
			sectionLines.push(`- ${unit.id}: ${unit.summary}`);
		}

		if (file.supportsHunkSplit) {
			sectionLines.push("Hunk details:");
			for (const unit of file.units) {
				sectionLines.push(`### ${unit.id}`);
				sectionLines.push(unit.detail.trim());
			}
		} else {
			sectionLines.push(file.detail.trim());
		}

		const section = sectionLines.join("\n");
		if (usedChars + section.length > MAX_PROMPT_CHARS) {
			lines.push("");
			lines.push("[Additional file details omitted because the prompt budget was exhausted.]");
			break;
		}
		lines.push(section);
		usedChars += section.length;
	}

	lines.push("");
	lines.push("Return JSON only.");
	return lines.join("\n");
}

function buildRepairPrompt(errors: string[], snapshot: RepoSnapshot): string {
	return [
		"Your previous JSON was invalid.",
		"Fix it and return corrected JSON only.",
		"",
		"Required schema:",
		'{"summary": string, "commits": [{"message": string, "why": string, "changes": string[]}]}',
		"",
		"Additional requirements:",
		"- Write summary and why fields in English.",
		"- Every commit message must use Conventional Commits format: type(scope): subject or type: subject.",
		"",
		"Validation errors:",
		...errors.map((error) => `- ${error}`),
		"",
		...buildUnitCatalog(snapshot.units),
	].join("\n");
}

function parseRawPlan(rawText: string, unitIds: string[]): ValidationResult {
	const candidate = extractJsonCandidate(rawText);
	if (!candidate) {
		return { ok: false, errors: ["Model response did not contain a JSON object"] };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, errors: [`Model JSON could not be parsed: ${message}`] };
	}

	return validateCommitPlan(parsed, unitIds);
}

function isConventionalCommitMessage(message: string): boolean {
	return /^[a-z]+(?:\([^)]+\))?!?:\s+\S.+$/.test(message);
}

function validatePlannedCommit(input: unknown, index: number): { commit?: PlannedCommit; errors: string[] } {
	const prefix = `Commit ${index + 1}`;
	if (!input || typeof input !== "object") {
		return { errors: [`${prefix} is not an object`] };
	}

	const record = input as Record<string, unknown>;
	const message = typeof record.message === "string" ? normalizeSubjectLine(record.message) : "";
	const why = typeof record.why === "string" ? record.why.trim() : "";
	const changes = Array.isArray(record.changes)
		? record.changes.map((change) => (typeof change === "string" ? change.trim() : "")).filter((change) => change.length > 0)
		: [];

	const errors: string[] = [];
	if (!message) {
		errors.push(`${prefix} is missing a valid one-line message`);
	} else if (!isConventionalCommitMessage(message)) {
		errors.push(`${prefix} message must use Conventional Commits format: type(scope): subject or type: subject`);
	}
	if (!why) errors.push(`${prefix} is missing a why explanation in English`);
	if (changes.length === 0) errors.push(`${prefix} must contain at least one change ID`);

	if (errors.length > 0) return { errors };
	return {
		commit: { message, why, changes },
		errors: [],
	};
}

export function validateCommitPlan(input: unknown, unitIds: string[]): ValidationResult {
	if (!input || typeof input !== "object") {
		return { ok: false, errors: ["Plan is not an object"] };
	}

	const record = input as Record<string, unknown>;
	const summary = typeof record.summary === "string" ? record.summary.trim() : "";
	if (!Array.isArray(record.commits)) {
		return { ok: false, errors: ["Plan.commits is not an array"] };
	}

	const errors: string[] = [];
	const commits: PlannedCommit[] = [];
	const allowedIds = new Set(unitIds);
	const seenIds = new Set<string>();

	for (const [index, commitInput] of record.commits.entries()) {
		const validation = validatePlannedCommit(commitInput, index);
		errors.push(...validation.errors);
		if (!validation.commit) continue;

		for (const changeId of validation.commit.changes) {
			if (!allowedIds.has(changeId)) {
				errors.push(`Commit ${index + 1} references unknown change ID: ${changeId}`);
				continue;
			}
			if (seenIds.has(changeId)) {
				errors.push(`Change ID appears in more than one commit: ${changeId}`);
				continue;
			}
			seenIds.add(changeId);
		}

		commits.push({
			message: validation.commit.message,
			why: validation.commit.why,
			changes: uniqueSorted(validation.commit.changes),
		});
	}

	if (commits.length === 0) {
		errors.push("Plan did not contain any valid commits");
	}

	const missingIds = unitIds.filter((id) => !seenIds.has(id));
	if (missingIds.length > 0) {
		errors.push(`Plan did not cover all change IDs: ${missingIds.join(", ")}`);
	}

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	return {
		ok: true,
		plan: {
			summary: summary || `Plan ${commits.length} commit${commits.length === 1 ? "" : "s"}`,
			commits,
		},
		errors: [],
	};
}

function getResponseText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export async function planCommits(
	ctx: ExtensionCommandContext,
	snapshot: RepoSnapshot,
	options?: PlanCommitsOptions,
): Promise<CommitPlan> {
	if (!ctx.model) {
		throw new Error("No model selected");
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	if (!auth.apiKey) {
		throw new Error(`No API key for ${ctx.model.provider}/${ctx.model.id}`);
	}

	const planningPrompt = buildPlanningPrompt(snapshot, options);
	const unitIds = snapshot.units.map((unit) => unit.id);
	const messages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: planningPrompt }],
			timestamp: Date.now(),
		},
	];

	let response = await complete(
		ctx.model,
		{ systemPrompt: SYSTEM_PROMPT, messages },
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096 },
	);
	let rawText = getResponseText(response);
	let validation = parseRawPlan(rawText, unitIds);
	if (validation.ok && validation.plan) {
		return validation.plan;
	}

	messages.push({
		role: "assistant" as const,
		content: [{ type: "text" as const, text: truncateMiddle(rawText || "(empty response)", 8_000) }],
		timestamp: Date.now(),
	});
	messages.push({
		role: "user" as const,
		content: [{ type: "text" as const, text: buildRepairPrompt(validation.errors, snapshot) }],
		timestamp: Date.now(),
	});

	response = await complete(
		ctx.model,
		{ systemPrompt: SYSTEM_PROMPT, messages },
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096 },
	);
	rawText = getResponseText(response);
	validation = parseRawPlan(rawText, unitIds);
	if (validation.ok && validation.plan) {
		return validation.plan;
	}

	throw new Error(`Commit plan was invalid after retry:\n${validation.errors.join("\n")}`);
}

export function formatPlanPreview(plan: CommitPlan, snapshot: RepoSnapshot): string {
	const unitMap = new Map(snapshot.units.map((unit) => [unit.id, unit]));
	const lines: string[] = [];
	lines.push(plan.summary);
	lines.push("Commit style: Conventional Commits");
	lines.push("Execution mode: mixed file-level + hunk-level grouping (v2)");
	if (snapshot.partiallyStagedPaths.length > 0) {
		lines.push(`Includes ${snapshot.partiallyStagedPaths.length} partially staged file(s).`);
	}
	lines.push("");

	plan.commits.forEach((plannedCommit, index) => {
		lines.push(`${index + 1}. ${plannedCommit.message}`);
		lines.push(`   Why: ${plannedCommit.why}`);
		const files = new Map<string, string[]>();
		for (const changeId of plannedCommit.changes) {
			const unit = unitMap.get(changeId);
			if (!unit) continue;
			const current = files.get(unit.path) ?? [];
			current.push(changeId);
			files.set(unit.path, current);
		}
		lines.push("   Files:");
		for (const [path, changeIds] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			lines.push(`   - ${path} [${changeIds.join(", ")}]`);
		}
		if (index < plan.commits.length - 1) {
			lines.push("");
		}
	});
	lines.push("");
	lines.push(`This will create ${plan.commits.length} commit${plan.commits.length === 1 ? "" : "s"}.`);
	return lines.join("\n");
}
