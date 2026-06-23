# Annotation schema

The renderer accepts `human-friendly-diff.analysis/v1`.

```json
{
  "schemaVersion": "human-friendly-diff.analysis/v1",
  "reviewPath": {
    "summary": "Suggested review sequence.",
    "checks": ["Question for the reviewer"]
  },
  "verification": [
    {
      "command": "npm test",
      "status": "passed",
      "note": "Observed in the active agent session"
    }
  ],
  "groups": [
    {
      "id": "stable-purpose-slug",
      "title": "Prevent duplicate checkout submissions",
      "summary": "Purpose-first explanation.",
      "attention": "routine",
      "attentionReason": "Why this level was chosen.",
      "confidence": "high",
      "hunkIds": ["src/file.js::0"],
      "crossReferences": ["another-group-id"],
      "reviewAfter": [],
      "risks": ["Specific risk or review question"],
      "questions": ["Should this have a regression test?"],
      "hunkExplanations": {
        "src/file.js::0": "Names the symbol and explains this hunk's role."
      }
    }
  ]
}
```

Rules:

- Every hunk ID comes from the capture file. Never invent or rewrite diff text.
- Place each hunk in one primary group.
- Use cross-references for secondary relationships.
- Prefer 3–8 coherent, purpose-first groups; there is no hard maximum.
- `attention` is `routine`, `review-carefully`, or `critical`.
- Reserve `critical` for likely secrets, destructive data changes,
  authentication/authorization changes, irreversible migrations, unresolved
  conflicts, or similarly severe uncertainty.
- `confidence` is `high`, `medium`, or `low`. Low confidence raises attention
  to at least `review-carefully`.
- Missing or duplicate assignments are repaired by the renderer. Unassigned
  hunks go to `Needs classification`.
- Verification entries must report only commands actually observed in the
  active agent session.
