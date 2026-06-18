import { resolve, sep } from "node:path";

export function splitZeroTerminated(text: string): string[] {
	if (!text) return [];
	return text.split("\0").filter((part) => part.length > 0);
}

export function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

export function truncateMiddle(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 32) return `${text.slice(0, maxChars)}…`;
	const head = Math.floor((maxChars - 9) / 2);
	const tail = maxChars - 9 - head;
	return `${text.slice(0, head)}\n…\n${text.slice(text.length - tail)}`;
}

export function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unitIndex]}`;
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split(/\r?\n/).length;
}

export function resolveInside(repoRoot: string, repoRelativePath: string): string {
	const root = resolve(repoRoot);
	const resolved = resolve(root, repoRelativePath);
	if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
		throw new Error(`Refusing to access path outside repo root: ${repoRelativePath}`);
	}
	return resolved;
}

export function isProbablyBinary(buffer: Buffer): boolean {
	for (const byte of buffer) {
		if (byte === 0) return true;
	}
	return false;
}

export function summarizePathList(paths: string[], max = 6): string {
	if (paths.length === 0) return "(none)";
	const preview = paths.slice(0, max).map((path) => `- ${path}`);
	if (paths.length > max) preview.push(`- …and ${paths.length - max} more`);
	return preview.join("\n");
}

export function normalizeSubjectLine(message: string): string {
	return message
		.split(/\r?\n/, 1)[0]
		.replace(/\s+/g, " ")
		.trim();
}

export function extractJsonCandidate(raw: string): string | null {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced?.[1]) return fenced[1].trim();

	const firstBrace = raw.indexOf("{");
	const lastBrace = raw.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return raw.slice(firstBrace, lastBrace + 1).trim();
	}

	return null;
}
