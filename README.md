# Pi Context ZIP

Pi package that adds Context ZIP compaction to Pi sessions.

Context ZIP creates an exact-first continuation artifact for long sessions: pinned constraints, structured state ledger, verbatim evidence, hot tail, and an archive index for omitted details.

## Features

- **Exact-first compaction** — keeps important facts, constraints, paths, commands, errors, and validation evidence before writing any lossy narrative summary.
- **Pinned constraints** — preserves project rules and user requirements so the next model turn does not forget what is forbidden or required.
- **Structured state ledger** — extracts the current goal, decisions, changed files, validation status, open questions, and next actions.
- **Verbatim evidence** — stores critical snippets as exact text: file paths, URLs, failing commands, test results, errors, and other anchors.
- **Hot tail** — keeps the most recent session context nearly verbatim, so continuation does not lose the latest user intent.
- **Archive index** — moves older bulky context into `.pi/context-archive/` with retrieval terms and summaries instead of dropping it completely.
- **Compaction hook** — can replace Pi's normal `/compact` or auto-compaction summary with a Context ZIP summary.
- **Command and tool API** — works both as `/context:zip` for users and `context_zip_create` for model-driven workflows.
- **Auditable artifacts** — writes JSON and Markdown artifacts under `.pi/context-zips/` so the compaction can be inspected later.

## Install

Global install:

```bash
pi install git:git@github.com:golovatskygroup/pi-context-zip.git
```

Project-local install:

```bash
pi install -l git:git@github.com:golovatskygroup/pi-context-zip.git
```

One-off run without installing:

```bash
pi -e git:git@github.com:golovatskygroup/pi-context-zip.git
```

## Use

```text
/context:zip
/context:zip --apply preserve current task, validation commands, file paths, and user constraints
```

`--apply` also appends the generated Context ZIP as a Pi compaction entry.

The package also exposes the tool `context_zip_create` for model-driven workflows.

Artifacts are written in the current project:

```text
.pi/context-zips/<id>.json
.pi/context-zips/<id>.md
.pi/context-archive/<id>-<group>.txt
```

Optional: set `PI_CONTEXT_ZIP_MODEL=provider/model` to force the child summarizer model. Otherwise it uses Pi's current/default model.
