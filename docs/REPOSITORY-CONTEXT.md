# Repository context and scale

Repository size and agent context size are separate. New guided tasks no longer
require the whole repository to fit in 256 KiB or 1024 files. Unchanged binary
assets can remain outside agent context while their bytes stay covered by artifact
verification. Symlinks and submodules remain unsupported.

## Autonomous exploration

In **New task**, enter the repository and describe the change, then choose
**Start planning**. No file selection is required. The planner lists files, searches
literal text and follows code, callers, dependencies, configuration and tests itself.
**Optional file hints** can supply useful starting files; suggestions remain filename
heuristics rather than dependency analysis. **Update file hints** invalidates a
previous proposal without starting inference. Removing a hint does not erase content
already present in a resumed provider transcript.

Both Codex and Claude use the same controller-owned read tools. Planning reads Git
blobs from the pinned commit, even if checkout files are dirty. Implementation reads
its captured workspace inventory, verifies supporting-file hashes, and permits
current bytes for explicitly authorized edit/create/delete paths. Review reads the
submitted snapshot, verifies each retrieved file and rechecks the complete artifact
before accepting a verdict. New files created by the implementation are available
through the approved creation paths. Untracked files outside the inventory and ignored
files are not exposed. Symlinks, filesystem aliases and non-UTF-8 text are refused.

Repository exploration never grants write permission. Approval still freezes the
pinned base, repository-read capability, exact file actions and check commands.
Review receives changed files, before/after evidence and repository instructions
upfront, then can inspect surrounding code itself. Unread files remain covered by
artifact verification, but hashing does not establish semantic review coverage.
Requests and the exact bounded tool results, including source identities, file hashes,
pagination and omissions, are retained in the session journal. The dashboard shows
completed exploration calls and recently read files during planning and execution.

New authored plans enable exploration by default, with repository instructions as
the only automatically supplied files. Optional initial context is explicit:

```json
"context": { "files": ["src/greeting.js"], "exploration": true }
```

Existing edit/delete paths must exist in the pinned inventory, but need not be in
starting hints. Existing saved plans and kickoff conversations retain their approved
capabilities and digests; start a new task to enable exploration. Explicit
`"exploration": false` preserves selected-context behavior for newly authored plans.
Low-level conversation sessions do not gain repository access implicitly.

The implementation uses Codex app-server dynamic tools (experimental API, verified
with installed CLI 0.163.0) and an in-process Claude SDK MCP server. Configured MCP
integrations remain available, including source-project connections carried into
isolated workspaces. Provider shell commands remain disabled. Existing
controller-owned validation and acceptance commands still run through their normal
supervised lifecycle.

## External reference folders and integrations

Add absolute paths under **Reference folders**, or mention folders in the original
task description. **Suggest from task description** previews detected folders.
The agent can propose another folder with a reason; the suggestion itself grants
no access. Add it and choose **Update reference folders**, then send the next
planning turn. Changing references invalidates the previous proposal.

List/search/read tools accept `root: "task"` (default) or `root: "reference-1"`,
`"reference-2"`, and so on. All task roles receive the same approved reference
roots. References are read-only background material and confer no write scope.
At most 16 folders may be selected. Git references read the pinned committed
subtree, excluding untracked, ignored and dirty checkout bytes. Plain folders
capture a hashed inventory; content changes require refreshing their selection.
Symlinks, hardlinks and oversized files are refused. Journals identify the root
and folder for each result; reports distinguish reference reads from task reads.

Configured MCP connections load from each provider's settings. Referenced tickets
can be retrieved directly; Grampus no longer disables all integrations. The
**MCP connections** card shows reported connection/authentication status and tool
counts without configuration secrets. External writes or messages require explicit
task authorization. Connections available to Codex can differ from Claude's.
Reset old tasks to start a fresh planning conversation with the new capabilities.

Run `npm run probe:mcp -- --live` for a real Linear read through Codex and a
source-project MCP fixture through Claude. `npm run probe:references -- --live`
checks both providers' actual external-folder list/search/read calls. These use
existing subscriptions and retain fixtures and journals under `.grampus/`.

## Budgets and performance

- Exploration lists return 100 paths per page. Reads return up to 400 lines and
  approximately 24 KiB of text, with an explicit next-line cursor; files are bounded
  to 32 MiB and lines above 24 KiB are refused. Search is case-insensitive literal
  text with an optional path substring filter, scans up to 128 files / approximately
  4 MiB per page, and returns up to 50 bounded match lines. Follow `nextOffset` even
  on an empty page. Binary/oversized files and additional matches are recorded;
  narrow the search or read the relevant file directly. Pinned search blobs are
  fetched in batches. Exploration is incremental and has no 512 KiB aggregate
  initial-context restriction. Existing turn deadlines and interruption apply.

- Initial supplied text context: at most 256 files, 256 KiB per file and 512 KiB in total.
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

Agents now discover context autonomously within their repository-read capability.
Changing approved write scope or requirements still requires a revised task.
Approved-recipe revisions and ordinary-project release trials remain work.

Run `npm run build` followed by `npm run probe:exploration -- --live` to exercise
both subscription providers against hidden dependency content, pinned/dirty checkout
differences, resumed sessions and workspace snapshots. It retains fixture repositories
and journals under ignored `.grampus/exploration-probes/` and makes no external changes.
