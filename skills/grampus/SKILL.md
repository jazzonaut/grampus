---
name: grampus
description: Start and control Grampus coding tasks from chat. Grampus runs a measured pipeline of Orca workers (spec, approval, build, deterministic checks, cross-family review, bounded repair) and asks the user only for decisions. Use when the user says "grampus", asks to start a task through Grampus, asks what needs them, or wants to approve a spec, answer a worker question, accept, continue or abandon a Grampus task.
---

# Grampus

Grampus is driven by its CLI, installed on the user's PATH. Run every command below exactly as
written. If the shell cannot find `grampus`, tell the user to restart Orca (it reads PATH when it
starts) or to install Grampus; do not look for another copy.

You act for the user. Grampus records every command you queue as coming from chat, so only queue a
decision the user actually made in this conversation. Never approve, accept or abandon on your own
judgement, and never edit a task's worktree yourself: workers do the work, Grampus verifies it.

- **Say only what has happened.** Describe a command as sent only after you ran it and saw
  `Queued ...`. While asking, say what you will do ("if you approve, I will start the build"), never
  "approving it now".
- **Grampus ends at a verified branch.** After `accept`, name the branch and worktree, and say the
  user can ask you to merge it. Only when they ask, run `{{grampus}} merge <task>`: it fast-forwards
  the branch checked out in their repository to the verified commit and refuses if that branch moved
  on or has uncommitted changes (relay the refusal; do not merge by hand). Never push or open pull
  requests unless the user asks for that in this conversation.

## Start a task

```text
{{grampus}} new [--repo <absolute repo path>] [--recipe <name>] [--title "<short title>"] --source chat "<request in the user's words>"
```

Without `--repo`, Grampus uses the repository of the current folder (the workspace this chat runs
in; a linked worktree resolves to its main checkout). Pass `--repo` only when the user names another
repository. `new` prints the repository it used: tell the user. This creates an Orca worktree, a terminal tab that runs the task's driver and, shortly after, the
spec writer. Tell the user they can stay in this chat: workers ask their questions through Grampus,
and you bring those questions, the spec and the result here. Then start `wait --after` with the
`as of` time that `new` printed. Use
`{{grampus}} recipes` to list recipes when the user asks for a particular pipeline.

## Compare recipes

When the user wants to know which recipe does a request best, start a comparison instead of a task:

```text
{{grampus}} compare [--repo <absolute repo path>] --recipes <a,b,...> [--mode full|shared] --source chat "<request>"
```

Each recipe runs as its own task (an entry) from the same base commit. In `full` mode (the default)
every entry writes its own spec, so the user approves one per recipe, and every result is then checked
against every spec. In `shared` mode the first recipe's spec is approved once and every recipe builds
from it. Entries show up in `status` and `wait` like tasks; the comparison block above them shows the
cross-check's progress and says when the user should pick. Only then: Grampus refuses a pick sent
before it asks. For an entry, never run `accept`: the user keeps one entry with `pick`, which ends the
others as not selected, and cannot be undone. Before asking, show each entry's result, and say which
did not pass everything. The dashboard shows the entries side by side.

## See what needs the user

```text
{{grampus}} status            all tasks, one block each
{{grampus}} status <task>     one task with its spec, checks and rounds
{{grampus}} wait [<task>] --after <time>   block until something newer needs the user (returns after about 9 minutes otherwise)
{{grampus}} report <task>     models, time, tokens and estimated cost per stage, rounds and human cost
```

Lines starting `NEEDS YOU`, `QUESTION` and `DRIVER STOPPED` are the ones to relay. `options:` lists
the commands the task accepts right now. Do not poll `status` in a loop.

Every `status` and `wait` output ends with `as of <time>`. **Always pass the last one you saw to the
next wait: `wait [<task>] --after <time>`.** Things happen while you talk to the user (a spec review
landing, a new question); a `wait` without `--after` only reports what happens after it starts and
would miss them.

## Decisions

Always pass `--source chat`.

| User says | Command |
| --- | --- |
| The spec is right | `{{grampus}} approve <task> --source chat` |
| Change the spec | `{{grampus}} revise <task> --source chat "<feedback>"` |
| Answers a worker question | `{{grampus}} reply <task> <message-id> --source chat "<answer>"` |
| Try again / do another round | `{{grampus}} continue <task> --source chat "<guidance>"` |
| Tests first wrote no tests; build without them | `{{grampus}} continue <task> --source chat "<note>"` |
| A stage failed to start or exited; retry it | `{{grampus}} retry <task> --source chat` |
| Accept the verified result | `{{grampus}} accept <task> --source chat` |
| Stop the task | `{{grampus}} abandon <task> --source chat "<reason>"` |
| Keep one comparison entry | `{{grampus}} pick <comparison> <task> --source chat` |
| Stop a whole comparison | `{{grampus}} abandon <comparison> --source chat "<reason>"` |

**Never ask for a decision the user cannot see.** Every decision request carries its evidence, and
you must show it in your reply before any question or choice. If your interface asks questions in a
separate dialog, write the evidence in your message first: the dialog alone is not enough.

- **Spec approval:** `wait` and `status` print the spec between `----- spec v<n> -----` and
  `----- end of spec -----`, then the checks as Grampus ran them on the original commit, then the
  review. Show the outcome, every acceptance criterion, the examples, the out-of-scope list, the
  checks and each review finding, and give the spec file path. For each check that fails on the
  original commit, show its log lines and say whether it fails only because the behaviour is missing
  (expected) or for another reason, such as no tests running or a missing tool (it can never pass,
  so the spec needs revising). If the checks or the review are still running, say so: the user may
  approve now or wait. If they wait, keep running `wait`: a fresh request for the same version
  arrives when each lands. Show what it found, and say clearly whether anything is blocking.
- **Accept, continue or escalation:** they print the round's result between `----- round <r> result`
  and `----- end of result -----`: commits and changed files, each check, integrity problems, the
  review verdict and findings, and why it needs the user. The block is short: copy it into your reply
  verbatim, then any `Note:` from the request, then your own reading. Do not replace it with a
  summary. Say plainly if the user would be accepting with unresolved problems.

A command is applied by the task's driver within a few seconds. After `accept` or `abandon`,
`wait --after <time>` returns as soon as the task has finished; then offer the `report`. If `status`
shows `Refused`, the decision no longer applies (for example, a newer spec version exists).

## When the driver stopped

`DRIVER STOPPED` means the driver could not continue safely, for example after an uncertain Orca call.
Tell the user the reason. They resume it by running `{{grampus}} drive <task>` in the task's Grampus
terminal tab in Orca; resuming replays the uncertain call safely and never starts a duplicate worker.
