# Repository context and scale

Repository size and agent context size are separate. Agents explore the repository
on demand through controller-owned read tools, while artifact verification still
covers every tracked and non-ignored untracked file. Unchanged binary assets can
stay outside agent context; their bytes remain hashed. Symlinks, submodules,
filesystem aliases and non-UTF-8 text are refused.

## Exploration

No file selection is required. The planner lists files, searches literal text and
follows code, callers, dependencies, configuration and tests itself. **Optional file
hints** supply starting files; suggestions are filename heuristics, not dependency
analysis. Removing a hint does not remove content already in a resumed conversation.

Codex and Claude use the same tools (`grampus_list_files`, `grampus_read_file`,
`grampus_search`, `grampus_read_changes`, `grampus_read_check`,
`grampus_read_dependency`, `grampus_suggest_reference_folder`). Codex receives them as
app-server dynamic tools (an experimental app-server API); Claude receives them from
an in-process SDK MCP server. Neither gets a shell.

| Role | Reads from |
| --- | --- |
| Planning | Git blobs at the pinned commit, even if the checkout is dirty |
| Implementation | The captured workspace inventory with verified hashes; current bytes only for authorized edit, create and delete paths |
| Review | The submitted snapshot, with every retrieved file verified and the whole artifact rechecked before a verdict is accepted |

Inventories include tracked files and non-ignored untracked files. Untracked ignored
dependencies, caches and build output are excluded; tracked files stay included even
if an ignore rule matches them. There is no extra ignore list, because tracked
lockfiles, generated sources and versioned assets can matter to a correct change.

`grampus_read_dependency` reads source of a package installed in the task workspace,
with bounded snippets and literal search, so inspecting a library option does not
need a whole bundled file. It is available during execution, not planning. `grampus_read_check` pages settled check evidence
and approved expectations for the current task and version.

Read access never grants write permission. Approval freezes the pinned base, read
capability, exact file actions and commands. Tool requests and their bounded results,
including source identities, hashes, pagination and omissions, are journaled. Hashing
an unread file proves its bytes, not that anyone reviewed it.

New plans enable exploration, with repository instructions as the only files supplied
automatically. Optional initial context is explicit:

```json
"context": { "files": ["src/greeting.js"], "exploration": true }
```

`"exploration": false` keeps strict selected-context behaviour. Plans saved before
exploration existed keep their approved capabilities; start a new task to use it.

## Editing limits

Exact file scope allows regular UTF-8 files up to 1 MiB each and 4 MiB of existing
text per slice, with at most 64 paths. Individual edit or patch text is capped at
256 KiB. Planning checks pinned file sizes before approval; runtime errors name the
path and reason. These limits apply equally to every filename. Codex receives bounded
initial editable text; larger or excess files are deferred with size and hash
metadata and read through the tools (null content means unread, not absent). The
authorization view shows complete approved contents regardless of the prompt budget.

## Reference folders and integrations

Add absolute paths under **Reference folders**, or mention them in the task
description and use **Suggest from task description**. An agent can propose a folder
with a reason; that grants nothing until you add it and choose **Update reference
folders**. Changing references invalidates the previous proposal.

Tools accept `root: "task"` (default) or `"reference-1"`, `"reference-2"` and so on. Every
role receives the same approved roots, read-only. At most 16 folders. Git references
read the pinned committed subtree; plain folders capture a hashed inventory and need
re-selecting after their contents change. Links and oversized files are refused.
Reports distinguish reference reads from task reads.

Configured MCP connections load from each provider's settings, and source-project
connections carry into isolated worktrees without enabling servers you disabled.
Referenced tickets, such as Linear issues, can be read directly. The **MCP
connections** card shows reported status and tool counts without secrets. External
writes or messages need explicit task authorization. Codex and Claude may have
different connections.

## Budgets

- **Listing:** 100 paths per page.
- **Reading:** up to 400 lines and about 24 KiB per page with a next-line cursor;
  files up to 32 MiB; lines over 24 KiB are refused. Mode `characters` pages up to
  12,000 string positions, including single-line files. Follow `nextOffset` even on an
  empty page.
- **Search:** case-insensitive literal text with an optional path filter, scanning up
  to 128 files or about 4 MiB per page and returning up to 50 match lines.
- **Initial supplied text:** at most 256 files, 256 KiB per file and 512 KiB in total.
  Excess changed-file text and diff content is deferred to `grampus_read_changes`, which
  lists 100 changed paths per page or pages recorded `before`/`after` content in
  12,000-character pages.
- **Review envelope:** 2 MiB inline. Retained change evidence is limited to 4 MiB.
  Repository instructions must fit inline.
- **Snapshots:** processed file by file with a 32 MiB per-file limit and no aggregate
  cap.
- **Caching:** pinned-tree metadata is held in an LRU of four trees, about 64 MiB.
  Mutable worktree bytes are never cached for verification. Selected blobs and
  delivery checks are read in batches.
- **Dashboard polling:** cached by journal revision; no inventories, delivery
  snapshots or inference. Reports load on request.
- **Git:** worktree creation has a five-minute timeout; routine inspection 30 seconds.

Full verification still reads every tracked and non-ignored untracked file, twice per
stable capture, at several gates. Large repositories pay that disk and hashing cost.

## Probes

```sh
npm run build
npm run probe:context -- --files 100000 --checkout
npm run probe:context -- --files 10000 --file-bytes 16384 --checkout
```

The offline scale probe retains synthetic fixtures and timings under
`.grampus/context-probes/` and uses no providers. The live probes
`npm run probe:exploration -- --live`, `npm run probe:mcp -- --live` and
`npm run probe:references -- --live` exercise both subscriptions against fixture
repositories, MCP servers and reference folders, retaining their journals under
`.grampus/`. None of them is evidence about ordinary projects.
