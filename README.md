# pi-commit-planner

`pi-commit-planner` is a [pi](https://pi.dev) extension that turns `/commit` into a guided commit workflow:

1. scan the current Git working tree
2. ask the active model to propose a commit plan
3. show the plan for confirmation
4. apply one or more commits if you approve

## Current behavior

- single command: `/commit`
- no manual staging required
- AI plans **one or more commits** from all current tracked + untracked changes
- confirmation is always required before Git is mutated
- you can reject a proposed plan and give the planner natural-language feedback to replan
- supports **mixed file-level + hunk-level grouping**
- supports repositories that already contain **partially staged files**
- if planning or commit execution fails, the extension restores the original working tree + index state

## What v2 adds

### Hunk-level split support

When a modified text file has multiple independent diff hunks, the planner can assign those hunks to different commits.

Execution works by:

- resetting the repo to the base state
- rebuilding each commit's cumulative file state deterministically
- staging only the paths touched by that commit
- committing incrementally

This avoids relying on brittle patch fuzzing during multi-commit execution.

### Partially staged file support

If a file already has both staged and unstaged changes, `/commit` no longer rejects it.
The planner ignores the current staging boundary and plans across the **full current working tree change set**.
If execution fails, the original index and working tree state are restored.

## Important limitations

### Hunk splitting is text-only

Hunk-level splitting is only used for normal modified text files with multiple diff hunks.
Binary files, symlinks, file mode changes, pure adds, pure deletes, and rename-like cases stay whole-file in v2.

### UI-required flow

This extension always asks for confirmation, so `/commit` is intended for interactive or other UI-enabled pi modes.

## Install

### Load directly from a local checkout

```bash
pi -e /path/to/pi-commit-planner
```

### Install as a local pi package

```bash
pi install /path/to/pi-commit-planner
```

## Usage

Inside a Git repo, run:

```text
/commit
```

The extension will:

- inspect current changes
- normalize them into one or more **change units**
  - whole-file units for simple/non-splittable cases
  - hunk units for splittable modified text files
- use the current pi model to generate a commit plan
- show the proposed commit messages and grouped change units
- present a custom three-choice review UI:
  - apply the current plan
  - replan
  - cancel
- if you choose replan, let you either:
  - write custom feedback
  - trigger a canned replan that prefers Conventional Commits
  - go back
- create the commits if you accept

## How planning works

The planner prompt includes:

- exact change IDs that must be covered exactly once
- recent commit subjects, so the model can mimic repository style
- per-file summaries
- whole-file diffs/previews or per-hunk diffs

The model must return JSON with this shape:

```json
{
  "summary": "Why this plan makes sense",
  "commits": [
    {
      "message": "refactor(auth): extract token parsing helpers",
      "why": "Pure refactor changes grouped together",
      "changes": ["H1", "H2", "F3"]
    }
  ]
}
```

## Replanning loop

If the first plan is not what you want, choose **Replan with feedback** and describe how the plan should change.
Examples:

- reduce this to two commits
- keep tests with implementation
- separate the parser hunks
- follow the recent conventional commit style more closely

Inside the replan flow there is also a built-in quick action: **Prefer Conventional Commits**.
That tells the planner to bias toward subjects like `feat(scope): ...`, `fix: ...`, `refactor(scope): ...`, and similar Conventional Commit forms.

The planner receives:

- the current repository snapshot
- the most recent plan
- your feedback history

It then generates a fresh plan that still has to cover every change ID exactly once.

## Safety model

- the planner can only assign provided change IDs
- every change ID must appear exactly once in the plan
- execution is done by the extension, not by the model directly
- the extension snapshots current file state **and the Git index** before mutating Git
- before apply, it re-scans the repo and replans if the changes drifted during review
- on failure, it rolls the repo back to the original working tree + index state

## Development notes

This package uses a `pi` manifest in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

A minimal smoke test is:

```bash
pi --no-session --no-context-files --no-extensions --extension . -p /commit
```

That verifies pi can load the extension package and invoke the command path without needing a normal chat turn.
