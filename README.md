# Human-Friendly Diff

Human-Friendly Diff is a local Codex plugin that turns a current-branch vs
target-branch comparison into a story-driven slide presentation.

It opens with production/test/other change-line totals and a functional module
map, then walks through chronological system stories. The capture uses the
merge base of the target branch and current `HEAD`, matching a pull request;
staged, unstaged, and untracked files are excluded. Each beat shows only the
relevant exact diff excerpt, with bounded full-file before/after snapshots for
GitHub-like context expansion. A deterministic zero-dependency Node.js renderer
creates one self-contained dark HTML deck.

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
node scripts/capture.mjs --repo /path/to/repo --base main --output /tmp/capture.json
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
