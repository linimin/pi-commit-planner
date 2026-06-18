import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatPlanPreview } from "./planner.ts";
import type { CommitPlan, RepoSnapshot } from "./types.ts";

export type ReviewAction = "apply" | "replan" | "cancel";

function pushWrapped(lines: string[], text: string, width: number): void {
	if (text.length === 0) {
		lines.push("");
		return;
	}
	for (const paragraph of text.split("\n")) {
		if (paragraph.length === 0) {
			lines.push("");
			continue;
		}
		lines.push(...wrapTextWithAnsi(paragraph, width));
	}
}

function pushWrappedWithPrefix(lines: string[], prefix: string, text: string, width: number): void {
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(text, contentWidth);
	for (const [index, line] of wrapped.entries()) {
		lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`);
	}
}

export async function reviewPlanCustomUi(
	ctx: ExtensionCommandContext,
	plan: CommitPlan,
	snapshot: RepoSnapshot,
	options?: { preferConventionalCommits?: boolean },
): Promise<ReviewAction> {
	const previewText = formatPlanPreview(plan, snapshot, options);

	return (
		(await ctx.ui.custom<ReviewAction | undefined>((tui, theme, _kb, done) => {
			let selectedIndex = 0;
			let cachedWidth: number | undefined;
			let cachedLines: string[] | undefined;

			const choices: Array<{
				value: ReviewAction;
				label: string;
				description: string;
			}> = [
				{
					value: "apply",
					label: "1. Apply plan",
					description: "Create the commits now.",
				},
				{
					value: "replan",
					label: "2. Replan with feedback",
					description: options?.preferConventionalCommits
						? "Give feedback and keep the Conventional Commits preference."
						: "Give feedback, including optional style requests like Conventional Commits.",
				},
				{
					value: "cancel",
					label: "3. Cancel",
					description: "Do nothing and leave the repository untouched.",
				},
			];

			function refresh() {
				cachedWidth = undefined;
				cachedLines = undefined;
				tui.requestRender();
			}

			function render(width: number): string[] {
				if (cachedLines && cachedWidth === width) return cachedLines;

				const renderWidth = Math.max(1, width);
				const lines: string[] = [];
				const border = theme.fg("accent", "─".repeat(renderWidth));

				lines.push(border);
				pushWrapped(lines, theme.fg("accent", theme.bold("Commit Plan Review")), renderWidth);
				lines.push("");
				pushWrapped(
					lines,
					theme.fg("muted", "Review the proposed plan, then choose one of the three actions below."),
					renderWidth,
				);
				lines.push("");

				pushWrapped(lines, theme.fg("text", previewText), renderWidth);
				lines.push("");
				pushWrapped(lines, theme.fg("accent", theme.bold("Actions")), renderWidth);

				for (const [index, choice] of choices.entries()) {
					const selected = index === selectedIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const label = selected ? theme.fg("accent", choice.label) : theme.fg("text", choice.label);
					pushWrappedWithPrefix(lines, prefix, label, renderWidth);
					pushWrappedWithPrefix(lines, "   ", theme.fg("muted", choice.description), renderWidth);
				}

				lines.push("");
				pushWrapped(
					lines,
					theme.fg("dim", "↑↓ or Tab to move • Enter to choose • 1/2/3 shortcuts • Esc to cancel"),
					renderWidth,
				);
				lines.push(border);

				cachedWidth = width;
				cachedLines = lines;
				return lines;
			}

			function handleInput(data: string): void {
				if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) {
					selectedIndex = (selectedIndex - 1 + choices.length) % choices.length;
					refresh();
					return;
				}
				if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
					selectedIndex = (selectedIndex + 1) % choices.length;
					refresh();
					return;
				}
				if (data === "1") {
					done("apply");
					return;
				}
				if (data === "2") {
					done("replan");
					return;
				}
				if (data === "3") {
					done("cancel");
					return;
				}
				if (matchesKey(data, Key.enter)) {
					done(choices[selectedIndex]?.value ?? "cancel");
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done("cancel");
				}
			}

			return {
				render,
				invalidate: () => {
					cachedWidth = undefined;
					cachedLines = undefined;
				},
				handleInput,
			};
		})) ?? "cancel"
	);
}
