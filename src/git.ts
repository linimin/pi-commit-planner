import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseUnifiedDiffHunks, summarizeHunkSnippet, synthesizeTextFromHunks } from "./diff.ts";
import type { ChangeKind, ChangeUnit, CommitPlan, ExecutionBackup, FileChange, MaterializationKind, RepoSnapshot } from "./types.ts";
import { countLines, formatBytes, isProbablyBinary, resolveInside, splitZeroTerminated, truncateMiddle, uniqueSorted } from "./utils.ts";

const MAX_DETAIL_CHARS = 12_000;

interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}

interface UnitCounters {
	hunk: number;
	whole: number;
}

async function runGit(pi: ExtensionAPI, repoRoot: string, args: string[]): Promise<GitResult> {
	const result = await pi.exec("git", ["-C", repoRoot, ...args]);
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
	};
}

async function runGitInPath(pi: ExtensionAPI, cwd: string, args: string[]): Promise<GitResult> {
	const result = await pi.exec("git", ["-C", cwd, ...args]);
	return {
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
	};
}

async function runGitOrThrow(pi: ExtensionAPI, repoRoot: string, args: string[], action: string): Promise<GitResult> {
	const result = await runGit(pi, repoRoot, args);
	if (result.code !== 0) {
		const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
		throw new Error(`${action} failed${detail ? `: ${detail}` : ""}`);
	}
	return result;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

async function ensureFileLike(path: string, repoRelativePath: string): Promise<void> {
	const entry = await lstat(path);
	if (entry.isDirectory() && !entry.isSymbolicLink()) {
		throw new Error(`Directory-like change is not supported yet: ${repoRelativePath}`);
	}
}

async function getRepoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await runGitInPath(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (result.code !== 0) {
		throw new Error("Current directory is not inside a Git repository");
	}
	return result.stdout.trim();
}

async function hasHeadCommit(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
	const result = await runGit(pi, repoRoot, ["rev-parse", "--verify", "HEAD"]);
	return result.code === 0;
}

async function getBranchName(pi: ExtensionAPI, repoRoot: string): Promise<string | null> {
	const result = await runGit(pi, repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	if (result.code !== 0) return null;
	return result.stdout.trim() || null;
}

async function getIndexPath(pi: ExtensionAPI, repoRoot: string): Promise<string> {
	const result = await runGitOrThrow(pi, repoRoot, ["rev-parse", "--git-path", "index"], "Find Git index path");
	return resolve(repoRoot, result.stdout.trim());
}

async function pathExistsInHead(pi: ExtensionAPI, repoRoot: string, repoRelativePath: string): Promise<boolean> {
	const result = await runGit(pi, repoRoot, ["ls-tree", "-r", "--name-only", "HEAD", "--", repoRelativePath]);
	if (result.code !== 0) return false;
	return result.stdout.trim().length > 0;
}

async function readHeadTextFile(pi: ExtensionAPI, repoRoot: string, repoRelativePath: string): Promise<string> {
	const result = await runGitOrThrow(pi, repoRoot, ["show", `HEAD:${repoRelativePath}`], `Read HEAD version of ${repoRelativePath}`);
	return result.stdout;
}

async function getChangeKind(
	pi: ExtensionAPI,
	repoRoot: string,
	hasHead: boolean,
	repoRelativePath: string,
	untrackedPaths: Set<string>,
): Promise<ChangeKind> {
	if (untrackedPaths.has(repoRelativePath)) return "untracked";
	const absolutePath = resolveInside(repoRoot, repoRelativePath);
	const exists = await pathExists(absolutePath);
	if (!exists) return "deleted";
	if (!hasHead) return "added";
	return (await pathExistsInHead(pi, repoRoot, repoRelativePath)) ? "modified" : "added";
}

async function getShortStat(
	pi: ExtensionAPI,
	repoRoot: string,
	hasHead: boolean,
	kind: ChangeKind,
	repoRelativePath: string,
): Promise<string> {
	if (!hasHead) {
		if (kind === "deleted") return "deleted file";
		const absolutePath = resolveInside(repoRoot, repoRelativePath);
		await ensureFileLike(absolutePath, repoRelativePath);
		const fileStat = await lstat(absolutePath);
		if (fileStat.isSymbolicLink()) {
			return `new symlink, ${formatBytes(fileStat.size)}`;
		}
		const buffer = await readFile(absolutePath);
		if (isProbablyBinary(buffer)) {
			return `new binary file, ${formatBytes(fileStat.size)}`;
		}
		return `new file, ${countLines(buffer.toString("utf8"))} lines, ${formatBytes(fileStat.size)}`;
	}

	if (kind === "deleted") return "deleted file";
	if (kind === "untracked") {
		const absolutePath = resolveInside(repoRoot, repoRelativePath);
		const fileStat = await lstat(absolutePath);
		return `${fileStat.isSymbolicLink() ? "untracked symlink" : "untracked file"}, ${formatBytes(fileStat.size)}`;
	}

	const result = await runGit(pi, repoRoot, ["diff", "--shortstat", "HEAD", "--", repoRelativePath]);
	const summary = result.stdout.trim();
	if (summary.length > 0) return summary;
	if (kind === "added") return "new tracked file";
	return "modified file";
}

async function readTextPreview(repoRoot: string, repoRelativePath: string): Promise<string> {
	const absolutePath = resolveInside(repoRoot, repoRelativePath);
	await ensureFileLike(absolutePath, repoRelativePath);
	const entry = await lstat(absolutePath);
	if (entry.isSymbolicLink()) {
		const target = await readlink(absolutePath);
		return `Current symlink target:\n${target}`;
	}

	const buffer = await readFile(absolutePath);
	if (isProbablyBinary(buffer)) {
		return `[Binary file contents omitted: ${formatBytes(buffer.length)}]`;
	}

	const text = buffer.toString("utf8");
	const truncated = truncateMiddle(text, MAX_DETAIL_CHARS);
	const omitted = text.length > truncated.length ? `\n[Preview truncated from ${text.length.toLocaleString()} chars]` : "";
	return `Current file contents:\n\n${truncated}${omitted}`;
}

function truncateDiff(diffText: string): string {
	const truncated = truncateMiddle(diffText, MAX_DETAIL_CHARS);
	const omitted = diffText.length > truncated.length ? `\n[Diff truncated from ${diffText.length.toLocaleString()} chars]` : "";
	return `${truncated}${omitted}`;
}

function isBinaryDiff(diffText: string): boolean {
	return diffText.includes("GIT binary patch") || /^Binary files /m.test(diffText);
}

function canSplitByHunk(diffText: string, kind: ChangeKind, materialization: MaterializationKind, finalExists: boolean): boolean {
	if (kind !== "modified" || materialization !== "text" || !finalExists) return false;
	const forbiddenMarkers = [
		"old mode ",
		"new mode ",
		"rename from ",
		"rename to ",
		"similarity index ",
		"dissimilarity index ",
		"new file mode ",
		"deleted file mode ",
	];
	return !forbiddenMarkers.some((marker) => diffText.includes(marker));
}

function nextWholeUnitId(counters: UnitCounters): string {
	counters.whole += 1;
	return `F${counters.whole}`;
}

function nextHunkUnitId(counters: UnitCounters): string {
	counters.hunk += 1;
	return `H${counters.hunk}`;
}

async function buildFileChange(
	pi: ExtensionAPI,
	repoRoot: string,
	hasHead: boolean,
	repoRelativePath: string,
	kind: ChangeKind,
	counters: UnitCounters,
): Promise<FileChange> {
	const absolutePath = resolveInside(repoRoot, repoRelativePath);
	const finalExists = await pathExists(absolutePath);
	const finalEntry = finalExists ? await lstat(absolutePath) : null;
	if (finalExists) {
		await ensureFileLike(absolutePath, repoRelativePath);
	}

	const diffText = hasHead
		? (await runGit(pi, repoRoot, [
				"diff",
				"--no-ext-diff",
				"--find-renames",
				"--unified=3",
				"HEAD",
				"--",
				repoRelativePath,
		  ])).stdout.trimEnd()
		: "";

	let materialization: MaterializationKind = "text";
	if (finalEntry?.isSymbolicLink()) {
		materialization = "symlink";
	} else if (isBinaryDiff(diffText)) {
		materialization = "binary";
	} else if (finalExists && !finalEntry?.isSymbolicLink()) {
		const currentBuffer = await readFile(absolutePath);
		if (isProbablyBinary(currentBuffer)) {
			materialization = "binary";
		}
	}

	const summary = await getShortStat(pi, repoRoot, hasHead, kind, repoRelativePath);
	const detail = diffText.length > 0 ? `Diff against HEAD:\n\n${truncateDiff(diffText)}` : await readTextPreview(repoRoot, repoRelativePath);
	const baseExists = hasHead && kind !== "untracked" ? await pathExistsInHead(pi, repoRoot, repoRelativePath) : false;

	if (canSplitByHunk(diffText, kind, materialization, finalExists)) {
		const parsedHunks = parseUnifiedDiffHunks(diffText, () => nextHunkUnitId(counters));
		if (parsedHunks.length > 1) {
			const units: ChangeUnit[] = parsedHunks.map((hunk, index) => ({
				id: hunk.id,
				path: repoRelativePath,
				kind: "hunk",
				summary: `hunk ${index + 1}: ${hunk.header} — ${summarizeHunkSnippet(hunk.rawPatch)}`,
				detail: hunk.rawPatch,
			}));
			return {
				path: repoRelativePath,
				kind,
				summary,
				detail,
				materialization,
				baseExists,
				finalExists,
				baseText: await readHeadTextFile(pi, repoRoot, repoRelativePath),
				units,
				hunks: parsedHunks,
				supportsHunkSplit: true,
			};
		}
	}

	return {
		path: repoRelativePath,
		kind,
		summary,
		detail,
		materialization,
		baseExists,
		finalExists,
		units: [
			{
				id: nextWholeUnitId(counters),
				path: repoRelativePath,
				kind: "whole-file",
				summary: `${kind}: ${summary}`,
				detail,
			},
		],
		supportsHunkSplit: false,
	};
}

function snapshotRoot(backup: ExecutionBackup): string {
	return join(backup.tempDir, "snapshot");
}

async function copyRepoEntry(source: string, destination: string): Promise<void> {
	const entry = await lstat(source);
	if (entry.isDirectory() && !entry.isSymbolicLink()) {
		throw new Error(`Directory copy is not supported for ${source}`);
	}

	await mkdir(dirname(destination), { recursive: true });
	if (entry.isSymbolicLink()) {
		const target = await readlink(source);
		await symlink(target, destination);
		return;
	}
	await copyFile(source, destination);
}

async function removePathIfPresent(path: string): Promise<void> {
	try {
		const entry = await lstat(path);
		await rm(path, {
			recursive: entry.isDirectory() && !entry.isSymbolicLink(),
			force: true,
		});
	} catch {
		// ignore missing paths
	}
}

async function createBackup(pi: ExtensionAPI, snapshot: RepoSnapshot): Promise<ExecutionBackup> {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-commit-planner-"));
	const indexPath = await getIndexPath(pi, snapshot.repoRoot);
	const indexBackupPath = join(tempDir, "index.backup");
	if (await pathExists(indexPath)) {
		await copyFile(indexPath, indexBackupPath);
	} else {
		await writeFile(indexBackupPath, "");
	}

	const backup: ExecutionBackup = {
		tempDir,
		repoRoot: snapshot.repoRoot,
		hasHead: snapshot.hasHead,
		originalHead: snapshot.hasHead
			? (await runGitOrThrow(pi, snapshot.repoRoot, ["rev-parse", "HEAD"], "Detect original HEAD")).stdout.trim()
			: null,
		branchName: snapshot.branchName,
		indexPath,
		indexBackupPath,
		changedPaths: [...snapshot.changedPaths],
		deletedPaths: new Set<string>(),
	};

	await mkdir(snapshotRoot(backup), { recursive: true });

	for (const repoRelativePath of snapshot.changedPaths) {
		const absolutePath = resolveInside(snapshot.repoRoot, repoRelativePath);
		if (!(await pathExists(absolutePath))) {
			backup.deletedPaths.add(repoRelativePath);
			continue;
		}
		await ensureFileLike(absolutePath, repoRelativePath);
		const destination = resolveInside(snapshotRoot(backup), repoRelativePath);
		await mkdir(dirname(destination), { recursive: true });
		await copyRepoEntry(absolutePath, destination);
	}

	return backup;
}

async function clearWorkingState(pi: ExtensionAPI, backup: ExecutionBackup): Promise<void> {
	if (backup.hasHead) {
		await runGitOrThrow(pi, backup.repoRoot, ["reset", "--hard", "HEAD"], "Reset repository");
	} else {
		await runGitOrThrow(pi, backup.repoRoot, ["reset", "--mixed"], "Reset unborn repository index");
	}
	await runGitOrThrow(pi, backup.repoRoot, ["clean", "-fd"], "Clean working tree");
}

async function restoreSnapshotEntry(backup: ExecutionBackup, repoRelativePath: string): Promise<void> {
	const destination = resolveInside(backup.repoRoot, repoRelativePath);
	if (backup.deletedPaths.has(repoRelativePath)) {
		await removePathIfPresent(destination);
		return;
	}

	const source = resolveInside(snapshotRoot(backup), repoRelativePath);
	if (!(await pathExists(source))) {
		throw new Error(`Missing backup entry for ${repoRelativePath}`);
	}
	await mkdir(dirname(destination), { recursive: true });
	await removePathIfPresent(destination);
	await copyRepoEntry(source, destination);
}

async function stagePaths(pi: ExtensionAPI, repoRoot: string, repoRelativePaths: string[]): Promise<void> {
	await runGitOrThrow(pi, repoRoot, ["add", "-A", "--", ...repoRelativePaths], "Stage planned files");
}

async function hasStagedChanges(pi: ExtensionAPI, repoRoot: string): Promise<boolean> {
	const result = await runGit(pi, repoRoot, ["diff", "--cached", "--quiet"]);
	if (result.code === 0) return false;
	if (result.code === 1) return true;
	throw new Error(`Unable to inspect staged changes: ${result.stderr.trim() || result.stdout.trim()}`);
}

async function commitOnce(pi: ExtensionAPI, repoRoot: string, message: string): Promise<void> {
	await runGitOrThrow(pi, repoRoot, ["commit", "-m", message], `Create commit \"${message}\"`);
}

async function restoreOriginalState(pi: ExtensionAPI, backup: ExecutionBackup): Promise<void> {
	if (backup.originalHead) {
		await runGitOrThrow(pi, backup.repoRoot, ["reset", "--hard", backup.originalHead], "Reset back to original HEAD");
	} else {
		if (backup.branchName) {
			const deleteRef = await runGit(pi, backup.repoRoot, ["update-ref", "-d", `refs/heads/${backup.branchName}`]);
			if (deleteRef.code !== 0 && deleteRef.code !== 1) {
				throw new Error(deleteRef.stderr.trim() || deleteRef.stdout.trim() || "failed to delete unborn branch ref");
			}
		}
		await runGitOrThrow(pi, backup.repoRoot, ["reset", "--mixed"], "Reset unborn repository state");
	}

	await runGitOrThrow(pi, backup.repoRoot, ["clean", "-fd"], "Clean repository during rollback");

	for (const repoRelativePath of backup.changedPaths) {
		await restoreSnapshotEntry(backup, repoRelativePath);
	}

	if (await pathExists(backup.indexBackupPath)) {
		await mkdir(dirname(backup.indexPath), { recursive: true });
		await copyFile(backup.indexBackupPath, backup.indexPath);
	}
}

async function writeTextPath(path: string, text: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await removePathIfPresent(path);
	await writeFile(path, text, "utf8");
}

async function materializePathForSelectedUnits(
	backup: ExecutionBackup,
	file: FileChange,
	selectedUnitIds: Set<string>,
): Promise<void> {
	const absolutePath = resolveInside(backup.repoRoot, file.path);
	if (file.supportsHunkSplit) {
		const selectedHunks = new Set(file.units.filter((unit) => selectedUnitIds.has(unit.id)).map((unit) => unit.id));
		const text = synthesizeTextFromHunks(file.baseText ?? "", file.hunks ?? [], selectedHunks);
		await writeTextPath(absolutePath, text);
		return;
	}

	const unit = file.units[0];
	if (!unit || !selectedUnitIds.has(unit.id)) {
		return;
	}

	if (!file.finalExists) {
		await removePathIfPresent(absolutePath);
		return;
	}

	await restoreSnapshotEntry(backup, file.path);
}

export async function scanRepository(pi: ExtensionAPI, cwd: string): Promise<RepoSnapshot> {
	const repoRoot = await getRepoRoot(pi, cwd);
	const hasHead = await hasHeadCommit(pi, repoRoot);
	const branchName = await getBranchName(pi, repoRoot);

	const stagedPaths = uniqueSorted(
		splitZeroTerminated((await runGit(pi, repoRoot, ["diff", "--cached", "--name-only", "-z"])).stdout),
	);
	const unstagedPaths = uniqueSorted(splitZeroTerminated((await runGit(pi, repoRoot, ["diff", "--name-only", "-z"])).stdout));
	const untrackedPaths = uniqueSorted(
		splitZeroTerminated((await runGit(pi, repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout),
	);
	const conflictPaths = uniqueSorted([
		...splitZeroTerminated((await runGit(pi, repoRoot, ["diff", "--name-only", "--diff-filter=U", "-z"])).stdout),
		...splitZeroTerminated((await runGit(pi, repoRoot, ["diff", "--cached", "--name-only", "--diff-filter=U", "-z"])).stdout),
	]);

	const changedPaths = uniqueSorted([...stagedPaths, ...unstagedPaths, ...untrackedPaths]);
	const stagedSet = new Set(stagedPaths);
	const unstagedSet = new Set(unstagedPaths);
	const untrackedSet = new Set(untrackedPaths);
	const partiallyStagedPaths = changedPaths.filter((path) => stagedSet.has(path) && unstagedSet.has(path));

	const recentCommitSubjects = hasHead
		? (await runGit(pi, repoRoot, ["log", "-n", "12", "--pretty=format:%s"])).stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean)
		: [];

	const counters: UnitCounters = { hunk: 0, whole: 0 };
	const files: FileChange[] = [];
	for (const repoRelativePath of changedPaths) {
		const kind = await getChangeKind(pi, repoRoot, hasHead, repoRelativePath, untrackedSet);
		files.push(await buildFileChange(pi, repoRoot, hasHead, repoRelativePath, kind, counters));
	}

	const units = files.flatMap((file) => file.units);
	return {
		repoRoot,
		hasHead,
		branchName,
		changedPaths,
		stagedPaths,
		unstagedPaths,
		untrackedPaths,
		partiallyStagedPaths,
		conflictPaths,
		recentCommitSubjects,
		files,
		units,
	};
}

export async function applyCommitPlan(
	pi: ExtensionAPI,
	snapshot: RepoSnapshot,
	plan: CommitPlan,
): Promise<{ commitCount: number }> {
	const backup = await createBackup(pi, snapshot);
	const fileByPath = new Map(snapshot.files.map((file) => [file.path, file]));
	const unitById = new Map(snapshot.units.map((unit) => [unit.id, unit]));
	const selectedUnitIds = new Set<string>();
	let commitCount = 0;

	try {
		await clearWorkingState(pi, backup);

		for (const plannedCommit of plan.commits) {
			const touchedPaths = uniqueSorted(
				plannedCommit.changes
					.map((changeId) => unitById.get(changeId)?.path)
					.filter((path): path is string => typeof path === "string"),
			);

			for (const changeId of plannedCommit.changes) {
				selectedUnitIds.add(changeId);
			}

			for (const path of touchedPaths) {
				const file = fileByPath.get(path);
				if (!file) {
					throw new Error(`Missing file metadata for ${path}`);
				}
				await materializePathForSelectedUnits(backup, file, selectedUnitIds);
			}

			await stagePaths(pi, backup.repoRoot, touchedPaths);
			if (!(await hasStagedChanges(pi, backup.repoRoot))) {
				throw new Error(`Planned commit \"${plannedCommit.message}\" did not stage any changes`);
			}

			await commitOnce(pi, backup.repoRoot, plannedCommit.message);
			commitCount += 1;
		}

		return { commitCount };
	} catch (error) {
		let rollbackError: string | null = null;
		try {
			await restoreOriginalState(pi, backup);
		} catch (restoreError) {
			rollbackError = restoreError instanceof Error ? restoreError.message : String(restoreError);
		}

		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			rollbackError
				? `${message}\nRollback also failed: ${rollbackError}`
				: `${message}\nOriginal working tree state has been restored.`,
		);
	} finally {
		await rm(backup.tempDir, { recursive: true, force: true });
	}
}
