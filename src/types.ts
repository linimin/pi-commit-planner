export type ChangeKind = "modified" | "added" | "deleted" | "untracked";
export type UnitKind = "whole-file" | "hunk";
export type MaterializationKind = "text" | "binary" | "symlink";

export interface ChangeUnit {
	id: string;
	path: string;
	kind: UnitKind;
	summary: string;
	detail: string;
}

export interface DiffHunk {
	id: string;
	header: string;
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	rawPatch: string;
	oldSegments: string[];
	newSegments: string[];
}

export interface FileChange {
	path: string;
	kind: ChangeKind;
	summary: string;
	detail: string;
	materialization: MaterializationKind;
	baseExists: boolean;
	finalExists: boolean;
	baseText?: string;
	units: ChangeUnit[];
	hunks?: DiffHunk[];
	supportsHunkSplit: boolean;
}

export interface RepoSnapshot {
	repoRoot: string;
	hasHead: boolean;
	branchName: string | null;
	changedPaths: string[];
	stagedPaths: string[];
	unstagedPaths: string[];
	untrackedPaths: string[];
	partiallyStagedPaths: string[];
	conflictPaths: string[];
	recentCommitSubjects: string[];
	files: FileChange[];
	units: ChangeUnit[];
}

export interface PlannedCommit {
	message: string;
	why: string;
	changes: string[];
}

export interface CommitPlan {
	summary: string;
	commits: PlannedCommit[];
}

export interface ValidationResult {
	ok: boolean;
	plan?: CommitPlan;
	errors: string[];
}

export interface ExecutionBackup {
	tempDir: string;
	repoRoot: string;
	hasHead: boolean;
	originalHead: string | null;
	branchName: string | null;
	indexPath: string;
	indexBackupPath: string;
	changedPaths: string[];
	deletedPaths: Set<string>;
}
