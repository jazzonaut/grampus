# Repository context and scale

Repository size and agent context size are separate. New guided tasks no longer
require the whole repository to fit in 256 KiB or 1024 files. Unchanged binary
assets can remain outside agent context while their bytes stay covered by artifact
verification. Symlinks and submodules remain unsupported.

## Choose context

In **New task**, describe the change and choose **Inspect repository context**.
This reads the pinned Git tree without calling a provider. Suggestions use task
words, filenames and common root configuration files; they are not dependency
analysis or a claim of complete coverage. Up to 64 files are suggested, plus
repository instructions. Inspect and edit the exact paths, one per line. Search
the full pinned inventory and add relevant callers, dependencies and tests. Search
returns 100 paths per page, even for a 100,000-file repository.

The preview shows included and omitted counts, a bounded directory summary and
the complete inventory digest. Every path outside the selected list is omitted
from the prompt. The pinned commit and exact paths determine its content. A moved
HEAD invalidates the preview before a new planning conversation can start.

During planning, **Update context** changes the selection without starting a turn.
It invalidates an earlier proposal. Send a message or answer the pending questions
to explicitly continue with the new pinned content. A resumed provider conversation
may still remember earlier content; removing a path does not erase its transcript.

Generated plans cannot silently select different context. Approval binds the exact
selection and inventory digest along with the existing recipe. The implementer
receives the selected supporting text without additional write permissions. Review
always includes every changed file, before/after evidence and repository
instructions, even when they fall outside the supporting selection. It records
the supplied paths, mandatory paths, omitted count and artifact inventory digest.
Reviewers are instructed to ask about missing context rather than assume omitted
code is correct. Omitted files were hashed, not reviewed.

Authored guided JSON plans can select context explicitly:

```json
"context": { "files": ["src/greeting.js", "src/format.js", "test/greeting.test.js"] }
```

Without this field, new authored plans receive suggestions; inspect the normalized
selection before approval. Existing-file edit/delete actions must be included in
that selection. New/deleted files and changes from earlier slices are supplied to
review automatically. Existing saved plans retain their original approval digests;
no recipe is silently upgraded. Low-level tasks without a guided selection still
use bounded full-text context.

## Budgets and performance

- Agent text context: at most 256 files, 256 KiB per file and 512 KiB in total.
  Required files exceeding the budget stop the workflow; nothing is truncated.
- Complete review envelope, including instructions and before/after evidence:
  at most 2 MiB. Retained repository change evidence remains limited to 4 MiB.
- Raw snapshots process files individually, with a 32 MiB per-file limit and no
  aggregate repository byte cap. Git metadata subprocess output remains bounded.
- An LRU cache holds immutable pinned-tree metadata, bounded to four trees and
  an estimated 64 MiB. Mutable worktree bytes are never cached for verification.
- Selected Git blobs are read in a batch. Delivery verifies raw commit/index blobs
  in size-bounded batches rather than launching Git for every file. Scope checking
  uses maps rather than repeated full-inventory searches.
- Dashboard polling caches compact responses by database revision. It sends no
  full snapshot inventory or delivery snapshot and loads reports only on request.
  Polling performs no repository scan or inference. Worktree creation has a
  five-minute Git timeout; routine workspace Git inspection retains 30 seconds.
  Standalone checkout disables automatic CRLF conversion for that command only,
  without editing Git configuration. Explicit attributes and filters still apply.
  Changed-file originals are fetched together, and oversized change evidence is
  refused during collection rather than after building a repository-wide diff.

Full artifact verification still reads the repository's nonignored tracked and
untracked bytes. A stable capture performs two matching snapshots. Several
workflow gates require captures, so large tasks still pay disk and hashing costs;
fast context lookup does not make full verification constant-time. Git worktree
creation also needs to materialize the checkout.

Run the offline scale probe after building:

```sh
npm run probe:context -- --files 100000 --checkout
npm run probe:context -- --files 10000 --file-bytes 16384 --checkout
```

It retains synthetic fixtures and JSON timings under ignored
`.grampus/context-probes/`. It uses no providers. The first exercises file count;
the second also exceeds the former 128 MiB aggregate snapshot bound. These probes
do not establish ordinary-project delivery or semantic review coverage.

Context selection remains supervised. Automatic dependency discovery, autonomous
context retrieval, approved-recipe revisions and ordinary-project release trials
remain work. If review discovers a missing dependency after approval, stop and
prepare a revised approved task rather than claim complete review.
