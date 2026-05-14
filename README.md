# Pi Context ZIP

Pi package that adds Context ZIP compaction to Pi sessions.

Context ZIP creates an exact-first continuation artifact for long sessions: pinned constraints, structured state ledger, verbatim evidence, hot tail, and an archive index for omitted details.

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
