# Pi Context ZIP

Pi package that installs the current `context-zip` extension for Pi sessions.

The extension replaces Pi compaction summaries with a dense, loss-minimizing Context ZIP summary. It preserves goals, constraints, exact paths, commands, errors, file operation metadata, source entry IDs, previous summaries, and concrete next steps so a long coding session can continue after compaction with less context loss.

## What it does

- Hooks Pi `session_before_compact` and provides a structured Context ZIP Markdown summary.
- Uses the currently selected Pi model for summarization via `@earendil-works/pi-ai`.
- Includes the previous compaction summary when one exists.
- Records source entry IDs, read files, modified files, token counts, split-turn metadata, and conversation character counts in compaction details.
- Automatically queues compaction after assistant messages when context usage reaches **60%** of the active model context window.
- Waits until `agent_end` before auto-compacting so tool-use turns are not interrupted mid-run.
- If compaction happened after a non-final assistant stop reason, queues a follow-up user message to resume the interrupted task.
- Falls back to Pi's default compaction if the active model or API key is unavailable, if the generated summary is empty, or if summarization fails.
- Adds slash commands for status and manual compaction.

## Install

Global install:

```bash
pi install git:git@github.com:golovatskygroup/pi-context-zip.git
```

Project-local install:

```bash
pi install -l git:git@github.com:golovatskygroup/pi-context-zip.git
```

One-off run from a local checkout without installing:

```bash
git clone git@github.com:golovatskygroup/pi-context-zip.git
pi -e ./pi-context-zip
```

## Use

Show extension status, threshold, current context usage, and current session:

```text
/context-zip-status
```

Trigger compaction immediately with optional preservation instructions:

```text
/context-zip-compact preserve current task, validation commands, exact file paths, and user constraints
```

Compaction also runs automatically after a turn when usage is at least 60% of the active model context window.

## Debugging

Set `CONTEXT_ZIP_DEBUG_LOG` to append JSONL debug events:

```bash
CONTEXT_ZIP_DEBUG_LOG=/tmp/context-zip-debug.jsonl pi
```

Useful events include context-usage samples, queued auto-compactions, compaction start/completion, fallback oversized-turn handling, and auto-resume decisions.

## Notes

This repository mirrors the single-file extension source from `context-zip.ts`. Older repository versions exposed `/context:zip` and a `context_zip_create` artifact tool; those legacy artifact commands are not part of the current extension source.
