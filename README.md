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

## Set up

```text
npm ci
npm run build
node dist/src/cli.js skill install
```

`skill install` writes the Grampus skill for Claude (`~/.claude/skills/grampus`) and Codex
(`~/.codex/skills/grampus`), so you can control Grampus from an Orca chat.

## Use it from chat

In any Claude or Codex chat in Orca:

> Start a Grampus task in D:\Code\MyApp: add CSV export to the reports page.

The agent runs `grampus new`. Grampus creates an Orca worktree and a terminal tab named
`Grampus: <title>` that runs the task's driver. The spec writer opens as its own Orca chat: discuss
the request there. Then ask your chat agent what needs you, approve the spec, answer questions and
accept the result. The agent can block on `grampus wait` until something new needs you.

## Use it from the terminal

```text
node dist/src/cli.js new --repo D:\Code\MyApp "Add CSV export to the reports page"
node dist/src/cli.js status
node dist/src/cli.js approve <task>
node dist/src/cli.js accept <task>
```

Run `node dist/src/cli.js --help` for every command. Grampus never pushes: the accepted work is a
branch in the task worktree, ready for your review and PR.
