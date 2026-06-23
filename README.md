# Human-Friendly Diff

Human-Friendly Diff is a local Codex plugin that reorganizes the current Git
working-tree diff around implementation intent rather than file names.

It captures the exact `HEAD → working tree` snapshot (including staged,
unstaged, and untracked files), assigns stable IDs to every hunk, and asks the
active agent to annotate those IDs. A deterministic zero-dependency Node.js
renderer then creates and opens one self-contained dark HTML report.

## Requirements

- Git
- Node.js 20 or newer
- macOS or Linux for automatic browser launch

## Plugin workflow

Invoke `@human-friendly-diff` or ask Codex to generate a human-friendly diff.
The bundled skill performs:

1. capture
2. intent analysis
3. deterministic render
4. browser launch

Reports are written to `/tmp/human-friendly-diff/`. The latest ten reports per
repository are retained.

## Manual development workflow

```sh
node scripts/capture.mjs --repo /path/to/repo --output /tmp/capture.json
node scripts/render.mjs \
  --capture /tmp/capture.json \
  --analysis examples/analysis.example.json \
  --output /tmp/report.html \
  --open
```

The analysis schema is documented in
[`docs/annotation-schema.md`](docs/annotation-schema.md).

## Privacy

Capture and rendering are local and make no network requests. Reports may
contain source code. Suspected secrets are flagged, not redacted.
