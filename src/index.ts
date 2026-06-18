import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { applyCommitPlan, scanRepository } from "./git.ts";
import { planCommits } from "./planner.ts";
import { reviewPlanCustomUi, type ReviewAction } from "./review-ui.ts";
import type { CommitPlan, RepoSnapshot } from "./types.ts";
import { summarizePathList } from "./utils.ts";

const STATUS_KEY = "pi-commit-planner";
const CONVENTIONAL_COMMITS_FEEDBACK =
	"Prefer Conventional Commits across the whole plan. Use type(scope): subject when a scope helps.";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function validateSnapshot(snapshot: RepoSnapshot): { ok: true } | { ok: false; message: string; level: "info" | "error" } {
	if (snapshot.changedPaths.length === 0) {
		return { ok: false, message: "No uncommitted changes found", level: "info" };
	}

	if (snapshot.conflictPaths.length > 0) {
		return {
			ok: false,
			message: `Resolve merge conflicts before /commit:\n${summarizePathList(snapshot.conflictPaths)}`,
			level: "error",
		};
	}

	return { ok: true };
}

function buildSnapshotSignature(snapshot: RepoSnapshot): string {
	return JSON.stringify({
		changedPaths: snapshot.changedPaths,
		files: snapshot.files.map((file) => ({
			path: file.path,
			kind: file.kind,
			summary: file.summary,
			detail: file.detail,
			supportsHunkSplit: file.supportsHunkSplit,
			units: file.units.map((unit) => ({
				path: unit.path,
				kind: unit.kind,
				summary: unit.summary,
				detail: unit.detail,
			})),
		})),
	});
}

async function reviewPlan(
	ctx: ExtensionCommandContext,
	plan: CommitPlan,
	snapshot: RepoSnapshot,
	options?: { preferConventionalCommits?: boolean },
): Promise<ReviewAction> {
	if (ctx.mode === "tui") {
		return reviewPlanCustomUi(ctx, plan, snapshot, options);
	}

	const confirmed = await ctx.ui.confirm(
		"Apply commit plan?",
		"This environment does not support the custom three-choice TUI. Choose Yes to apply now or No for more options.",
	);
	if (confirmed) return "apply";

	const choice = await ctx.ui.select("Plan not applied. What next?", ["Replan with feedback", "Cancel"]);
	return choice === "Replan with feedback" ? "replan" : "cancel";
}

async function collectReplanFeedback(
	ctx: ExtensionCommandContext,
	preferConventionalCommits: boolean,
): Promise<{ feedback?: string; preferConventionalCommits?: boolean } | undefined> {
	const choices = ["Write custom feedback"];
	if (!preferConventionalCommits) {
		choices.push("Prefer Conventional Commits");
	}
	choices.push("Back");

	const choice = await ctx.ui.select("How should the planner revise this plan?", choices);
	if (!choice || choice === "Back") {
		ctx.ui.notify("Keeping the current plan.", "info");
		return undefined;
	}

	if (choice === "Prefer Conventional Commits") {
		return {
			feedback: CONVENTIONAL_COMMITS_FEEDBACK,
			preferConventionalCommits: true,
		};
	}

	ctx.ui.notify(
		"Describe how the plan should change. Example: reduce to two commits, keep tests with implementation, or separate specific hunks.",
		"info",
	);

	const feedback = await ctx.ui.editor("Feedback for replanning", "");
	if (feedback === undefined) {
		ctx.ui.notify("Replan feedback cancelled. Keeping the current plan.", "info");
		return undefined;
	}

	const trimmed = feedback.trim();
	if (!trimmed) {
		ctx.ui.notify("Feedback was empty. Keeping the current plan.", "warning");
		return undefined;
	}

	return { feedback: trimmed };
}

export default function commitPlannerExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Plan one or more Git commits from current changes, then ask for confirmation",
		handler: async (args, ctx) => {
			if (args.trim()) {
				if (ctx.hasUI) {
					ctx.ui.notify("/commit does not take arguments yet", "warning");
				} else {
					console.error("[pi-commit-planner] /commit does not take arguments yet");
				}
				return;
			}

			if (!ctx.hasUI) {
				console.error("[pi-commit-planner] /commit requires a UI-enabled mode because it always asks for confirmation.");
				return;
			}

			await ctx.waitForIdle();

			try {
				if (!ctx.model) {
					ctx.ui.notify("No model selected", "error");
					return;
				}

				ctx.ui.setStatus(STATUS_KEY, "Scanning Git changes...");
				let snapshot = await scanRepository(pi, ctx.cwd);
				const initialValidation = validateSnapshot(snapshot);
				if (!initialValidation.ok) {
					ctx.ui.notify(initialValidation.message, initialValidation.level);
					return;
				}

				let snapshotSignature = buildSnapshotSignature(snapshot);
				let feedbackHistory: string[] = [];
				let preferConventionalCommits = false;

				ctx.ui.setStatus(STATUS_KEY, `Planning commits for ${snapshot.units.length} change unit(s)...`);
				let plan = await planCommits(ctx, snapshot, {
					preferConventionalCommits,
				});

				while (true) {
					ctx.ui.setStatus(STATUS_KEY, undefined);
					const action = await reviewPlan(ctx, plan, snapshot, {
						preferConventionalCommits,
					});

					if (action === "cancel") {
						ctx.ui.notify("Commit cancelled", "info");
						return;
					}

					if (action === "replan") {
						const replanRequest = await collectReplanFeedback(ctx, preferConventionalCommits);
						if (!replanRequest) {
							continue;
						}

						if (replanRequest.preferConventionalCommits) {
							preferConventionalCommits = true;
						}
						if (replanRequest.feedback && !feedbackHistory.includes(replanRequest.feedback)) {
							feedbackHistory = [...feedbackHistory, replanRequest.feedback];
						}
						ctx.ui.setStatus(STATUS_KEY, `Replanning with feedback (${feedbackHistory.length})...`);
						plan = await planCommits(ctx, snapshot, {
							previousPlan: plan,
							feedbackHistory,
							preferConventionalCommits,
						});
						continue;
					}

					ctx.ui.setStatus(STATUS_KEY, "Re-scanning Git changes before apply...");
					const latestSnapshot = await scanRepository(pi, ctx.cwd);
					const latestValidation = validateSnapshot(latestSnapshot);
					if (!latestValidation.ok) {
						ctx.ui.notify(latestValidation.message, latestValidation.level);
						return;
					}

					const latestSignature = buildSnapshotSignature(latestSnapshot);
					if (latestSignature !== snapshotSignature) {
						snapshot = latestSnapshot;
						snapshotSignature = latestSignature;
						ctx.ui.notify(
							"Repository changes drifted while reviewing the plan. Replanning with current feedback.",
							"warning",
						);
						ctx.ui.setStatus(STATUS_KEY, `Planning commits for ${snapshot.units.length} change unit(s)...`);
						plan = await planCommits(ctx, snapshot, {
							feedbackHistory,
							preferConventionalCommits,
						});
						continue;
					}

					ctx.ui.setStatus(STATUS_KEY, `Creating ${plan.commits.length} commit(s)...`);
					const result = await applyCommitPlan(pi, snapshot, plan);
					ctx.ui.notify(
						result.commitCount === 1
							? `Created commit: ${plan.commits[0]?.message ?? "(unknown)"}`
							: `Created ${result.commitCount} commits`,
						"info",
					);
					return;
				}
			} catch (error) {
				ctx.ui.notify(`pi-commit-planner failed: ${errorMessage(error)}`, "error");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});
}
