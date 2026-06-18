import type { DiffHunk } from "./types.ts";

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseCount(rawStart: string, rawCount: string | undefined): number {
	if (rawCount !== undefined) return Number.parseInt(rawCount, 10);
	return rawStart === "0" ? 0 : 1;
}

function stripLastTrailingNewline(segments: string[]): void {
	if (segments.length === 0) return;
	const last = segments[segments.length - 1]!;
	if (last.endsWith("\n")) {
		segments[segments.length - 1] = last.slice(0, -1);
	}
}

function finalizeCurrent(
	hunks: DiffHunk[],
	current:
		| {
				header: string;
				oldStart: number;
				oldLines: number;
				newStart: number;
				newLines: number;
				rawPatchLines: string[];
				oldSegments: string[];
				newSegments: string[];
		  }
		| undefined,
	idFactory: (index: number) => string,
): void {
	if (!current) return;
	hunks.push({
		id: idFactory(hunks.length),
		header: current.header,
		oldStart: current.oldStart,
		oldLines: current.oldLines,
		newStart: current.newStart,
		newLines: current.newLines,
		rawPatch: current.rawPatchLines.join("\n").trimEnd(),
		oldSegments: current.oldSegments,
		newSegments: current.newSegments,
	});
}

export function parseUnifiedDiffHunks(diffText: string, idFactory: (index: number) => string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	const lines = diffText.split("\n");
	let current:
		| {
				header: string;
				oldStart: number;
				oldLines: number;
				newStart: number;
				newLines: number;
				rawPatchLines: string[];
				oldSegments: string[];
				newSegments: string[];
		  }
		| undefined;
	let lastOperation: "context" | "old" | "new" | null = null;

	for (const line of lines) {
		if (line.startsWith("@@ ")) {
			finalizeCurrent(hunks, current, idFactory);
			const match = line.match(HUNK_HEADER_RE);
			if (!match) {
				throw new Error(`Invalid hunk header: ${line}`);
			}

			const [, rawOldStart, rawOldLines, rawNewStart, rawNewLines] = match;
			current = {
				header: line,
				oldStart: Number.parseInt(rawOldStart!, 10),
				oldLines: parseCount(rawOldStart!, rawOldLines),
				newStart: Number.parseInt(rawNewStart!, 10),
				newLines: parseCount(rawNewStart!, rawNewLines),
				rawPatchLines: [line],
				oldSegments: [],
				newSegments: [],
			};
			lastOperation = null;
			continue;
		}

		if (!current) continue;

		if (line === "\\ No newline at end of file") {
			current.rawPatchLines.push(line);
			if (lastOperation === "context") {
				stripLastTrailingNewline(current.oldSegments);
				stripLastTrailingNewline(current.newSegments);
			} else if (lastOperation === "old") {
				stripLastTrailingNewline(current.oldSegments);
			} else if (lastOperation === "new") {
				stripLastTrailingNewline(current.newSegments);
			}
			continue;
		}

		const marker = line[0];
		if (marker !== " " && marker !== "+" && marker !== "-") {
			continue;
		}

		const segment = `${line.slice(1)}\n`;
		current.rawPatchLines.push(line);
		if (marker === " ") {
			current.oldSegments.push(segment);
			current.newSegments.push(segment);
			lastOperation = "context";
		} else if (marker === "-") {
			current.oldSegments.push(segment);
			lastOperation = "old";
		} else if (marker === "+") {
			current.newSegments.push(segment);
			lastOperation = "new";
		}
	}

	finalizeCurrent(hunks, current, idFactory);
	return hunks;
}

export function splitTextSegments(text: string): string[] {
	if (text.length === 0) return [];
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

export function synthesizeTextFromHunks(baseText: string, hunks: DiffHunk[], selectedHunkIds: Set<string>): string {
	const baseSegments = splitTextSegments(baseText);
	const result: string[] = [];
	let baseCursor = 0;

	for (const hunk of hunks) {
		const baseStartIndex = Math.max(0, hunk.oldStart - 1);
		result.push(...baseSegments.slice(baseCursor, baseStartIndex));
		result.push(...(selectedHunkIds.has(hunk.id) ? hunk.newSegments : hunk.oldSegments));
		baseCursor = baseStartIndex + hunk.oldSegments.length;
	}

	result.push(...baseSegments.slice(baseCursor));
	return result.join("");
}

export function summarizeHunkSnippet(rawPatch: string): string {
	const lines = rawPatch.split(/\r?\n/);
	for (const line of lines) {
		if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
			const content = line.slice(1).trim();
			if (content.length > 0) {
				return content.length > 72 ? `${content.slice(0, 72)}…` : content;
			}
		}
	}
	return lines[0] ?? "hunk";
}
