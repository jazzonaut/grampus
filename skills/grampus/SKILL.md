---
name: grampus
description: Start and control Grampus coding tasks from chat. Grampus runs a measured pipeline of Orca workers (spec, approval, build, deterministic checks, cross-family review, bounded repair) and asks the user only for decisions. Use when the user says "grampus", asks to start a task through Grampus, asks what needs them, or wants to approve a spec, answer a worker question, accept, continue or abandon a Grampus task.
---

# Grampus

Grampus is driven by its CLI. Run every command below exactly as written, including its full
executable path and data directory.

You act for the user. Grampus records every command you queue as coming from chat, so only queue a
decision the user actually made in this conversation. Never approve, accept or abandon on your own
judgement, and never edit a task's worktree yourself: workers do the work, Grampus verifies it.

## Start a task

```text
{{grampus}} new --repo <absolute repo path> [--recipe <name>] [--title "<short title>"] --source chat "<request in the user's words>"
```

This creates an Orca worktree, a terminal tab that runs the task's driver and, shortly after, the
spec writer. Tell the user they can stay in this chat: workers ask their questions through Grampus,
and you bring those questions, the spec and the result here. Then start `wait`. Use
`{{grampus}} recipes` to list recipes when the user asks for a particular pipeline.

## See what needs the user

```text
{{grampus}} status            all tasks, one block each
{{grampus}} status <task>     one task with its spec, checks and rounds
{{grampus}} wait [<task>]     block until something new needs the user (returns after about 9 minutes otherwise)
{{grampus}} report <task>     models, time and tokens per stage, rounds and human cost
```

Lines starting `NEEDS YOU`, `QUESTION` and `DRIVER STOPPED` are the ones to relay. `options:` lists
the commands the task accepts right now. To keep watching, call `wait` again after relaying
what it returned; do not poll `status` in a loop.

## Decisions

Always pass `--source chat`.

| User says | Command |
| --- | --- |
| The spec is right | `{{grampus}} approve <task> --source chat` |
| Change the spec | `{{grampus}} revise <task> --source chat "<feedback>"` |
| Answers a worker question | `{{grampus}} reply <task> <message-id> --source chat "<answer>"` |
| Try again / do another round | `{{grampus}} continue <task> --source chat "<guidance>"` |
| A stage failed to start or exited; retry it | `{{grampus}} retry <task> --source chat` |
| Accept the verified result | `{{grampus}} accept <task> --source chat` |
| Stop the task | `{{grampus}} abandon <task> --source chat "<reason>"` |

**Never ask for a decision the user cannot see.** Every decision request carries its evidence, and
you must show it in your reply before any question or choice. If your interface asks questions in a
separate dialog, write the evidence in your message first: the dialog alone is not enough.

- **Spec approval:** `wait` and `status` print the spec between `----- spec v<n> -----` and
  `----- end of spec -----`, then its review. Show the outcome, every acceptance criterion, the
  examples, the out-of-scope list, the checks and each review finding, and give the spec file path.
  If the review is still running, say so: the user may approve now or wait. A later request for the
  same version means the review found something blocking or failed; show what it found.
- **Accept, continue or escalation:** they print the round's result between `----- round <r> result`
  and `----- end of result -----`: commits and changed files, each check, integrity problems, the
  review verdict and findings, and why it needs the user. Show all of it, plus any `Note:` in the
  request, and say plainly if the user would be accepting with unresolved problems.

A command is applied by the task's driver within a few seconds; confirm with `status`. If `status`
shows `Refused`, the decision no longer applies (for example, a newer spec version exists).

## When the driver stopped

`DRIVER STOPPED` means the driver could not continue safely, for example after an uncertain Orca call.
Tell the user the reason. They resume it by running `{{grampus}} drive <task>` in the task's Grampus
terminal tab in Orca; resuming replays the uncertain call safely and never starts a duplicate worker.
