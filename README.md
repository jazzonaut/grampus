# Grampus

Grampus turns a plain-language coding request into a verified result. It runs a fixed pipeline of
Claude and Codex workers on [Orca](https://www.onorca.dev/docs/orchestration): a spec you approve, a
build, checks that Grampus runs itself against the exact commit, an independent review by the other
model family and bounded repair. It asks you only for decisions, and records every stage so different
recipes (models, stages, repair budgets) can be compared.

- [How it works](docs/ARCHITECTURE.md)
- [Design and decisions](DESIGN.md)
- [Configuration](docs/CONFIGURATION.md)

## Requirements

- Orca 1.4.237 or later, running, with the Claude and Codex agents enabled and signed in.
- Node.js 24 or later (`node` on the PATH of Orca terminals), npm and Git.
- Windows is the tested platform. macOS and Linux are **Planned**.

## Install

From a checkout of the commit you want:

```text
npm ci
npm run install:local
```

This builds the checkout and installs it as a new version in `%LOCALAPPDATA%\Programs\Grampus`:

- `grampus` goes on your user PATH and always runs the newest installed version. After the first
  install, restart Orca and open new terminals so they see the PATH change.
- Each version is an immutable folder named by its build id, `<package version>+<commit>`, such as
  `0.8.0+a1daeb8c3f21`. `grampus --version` shows the running one. Running tasks and the dashboard keep
  the code they started with; a driver restarted later runs the newest version.
- The Grampus skill is installed for Claude (`~/.claude/skills/grampus`) and Codex
  (`~/.codex/skills/grampus`) and runs `grampus` from PATH, so you can control Grampus from an Orca chat.
- The newest three versions are kept (`keptVersions` in [Configuration](docs/CONFIGURATION.md)).

The installer refuses uncommitted changes; `npm run install:local -- --dirty` installs them anyway,
with `.dirty.<time>` in the build id. Reinstalling the same commit just selects it again. Other options:
`--dir <folder>` and `--no-path`. To release a new version number, change `version` in `package.json`.

### Update

Commit in the checkout, then from anywhere:

```text
grampus update
```

It builds and installs whatever is committed in the checkout Grampus was installed from, and says so
when that commit is already running. It never fetches or pulls, so pull first if the commits are on a
remote. `--from <checkout>` updates from another checkout (for example after removing a worktree) and
`--dirty` includes uncommitted changes. If the update changed dependencies, run `npm ci` in the checkout
first.

Installed Grampus keeps its tasks in `%LOCALAPPDATA%\Grampus\orca`. Running from a checkout
(`node dist/src/cli.js`) uses `%LOCALAPPDATA%\Grampus\orca-dev`, so development builds never touch
real tasks.

## Use it from chat

In any Claude or Codex chat in Orca:

> Start a Grampus task: add CSV export to the reports page.

The task uses the repository your chat runs in; name another one ("in D:\Code\MyApp") if needed.

The agent runs `grampus new`. Grampus creates an Orca worktree and a terminal tab named
`Grampus: <title>` that runs the task's driver; you can leave both alone. Stay in your chat: the spec
writer's questions, the spec to approve and the result to accept all come to you there. Then ask your chat agent what needs you, approve the spec, answer questions and
accept the result. The agent can block on `grampus wait` until something new needs you.

## Use the dashboard

```text
grampus dashboard
```

Open the printed address (`http://localhost:4545/`, or this machine's network address from a phone). The
dashboard shows every task's pipeline, spec, checks, reviews, worker questions, timeline and scorecard,
and updates live. You can start tasks, approve, answer questions, accept, merge and edit recipes there
too. It has no login: anyone who can reach the port can control your tasks, so only run it
on networks you trust, or set `dashboardHost` to `127.0.0.1` (see [Configuration](docs/CONFIGURATION.md)).

## Compare recipes

```text
grampus compare --recipes standard,economy-codex "Add CSV export to the reports page"
```

Each recipe runs as its own task from the same base commit. By default each writes its own spec (you
approve each) and every result is also checked against the other specs; `--mode shared` writes one spec
and builds every recipe from it. When they are done, compare them in the dashboard and keep one with
`grampus pick <comparison> <task>`.

## Use it from the terminal

```text
grampus new "Add CSV export to the reports page"          # repository of the current folder
grampus new --repo D:\Code\MyApp "Add CSV export ..."    # or a named one
grampus status
grampus approve <task>
grampus accept <task>
grampus abandon <task> "reason"
grampus report <task>
```

Run `grampus --help` for every command. The accepted work is a verified commit on the task
branch. `grampus merge <task>` (or "merge it" in chat) fast-forwards the branch checked out in your
repository to that commit, and refuses if the branch has moved on or has uncommitted changes. Grampus
never pushes or opens pull requests.
