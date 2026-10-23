// Task specs given to Orca workers. Orca prepends its own preamble (task and dispatch ids, the exact
// `worker_done` and `ask` commands); these texts say what to do. Each follows Orca's task-spec contract:
// target, change, constraints, ownership and observable acceptance. Prompt text is a contract with the
// agents: change it deliberately, and expect measured results to move when it does.
import { polishLimits } from '../config/limits.js';
import type { CheckResult } from '../domain/events.js';
import type { Finding } from '../domain/review.js';
import type { CheckDefinition } from '../domain/spec.js';

const specFormat = `Spec format (Markdown):

# <short title>
## Outcome
Two to five sentences: what changes, for whom, and why.
## Acceptance criteria
A numbered list. Each criterion is observable and testable.
## Examples
Concrete inputs and expected outputs, including edge cases and missing or invalid values.
## Out of scope
## Assumptions
Defaults you chose for minor details.
## Approach (provisional)
A short sketch. The builder may change it.

Then exactly one fenced code block whose info string is \`grampus\`, containing JSON:

\`\`\`grampus
{"checks": [{"name": "unit tests", "command": "npm test -- src/export.test.ts", "timeoutSeconds": 600}], "protected": [],
 "acceptance": [{"id":"export-result","request":"the requested export outcome","scenario":"concrete action and expected result",
 "checks":["unit tests"],"realComponents":["export entry point"],"mockedComponents":[],"limitations":[]}]}
\`\`\`

- "checks": commands run from the repository root, non-interactively, that exit 0 only when the
  criteria hold. Prefer the project's existing commands and narrow them to the relevant tests. Each
  must be deterministic and finish within its timeout. They may name tests the builder will add; say
  under the criteria which tests are expected.
- A check must exit 0 whenever the tests it targets pass. Narrow by test project or package, not by a
  filter over a whole solution or workspace: some runners fail when a project runs no tests. Grampus
  runs every check on the current commit before approval and shows the user any that fail.
- A check may declare "portable": true only when its tests use stable, existing public interfaces
  and observable behaviour rather than implementation-specific helpers. This is an explicit claim
  reviewed with the spec; without it, a cross-check failure has unknown behavioural meaning.
- "protected": repository globs the builder must not change (usually empty).
- "acceptance": map every requested outcome to at least one executable scenario. Use unique stable ids
  and declared check names. Name the real components exercised, mocked components and known limitations.
  Trace the user's action through the relevant production boundaries before choosing a test seam.
  Manually injecting the state that should result from a journey does not prove the journey works.
  Keep this proportional: a pure function can need one direct test; a reconnect request needs evidence
  across the transport and identity boundaries it depends on. Do not require unrelated end-to-end suites.
  State gaps honestly rather than narrowing the request to what a convenient unit test can prove.`;

const reportFormat = `Write the report as JSON:

{"verdict": "approve" | "changes" | "unknown",
 "summary": "<two or three sentences>",
 "findings": [{"severity": "blocking" | "note", "title": "...", "file": "path", "line": 12,
               "criterion": "<quoted criterion, if any>", "scenario": "<inputs or steps that go wrong>",
               "detail": "..."}]}

Use "unknown" when you cannot decide; it is a valid answer and better than a guess.`;

// The user reads a failure report before deciding, so it is short and scannable; the dashboard renders it
// as Markdown.
const failureReport = `Before you send --outcome failed, commit the work worth keeping: uncommitted work is
not reviewed and the next round cannot build on it. With --outcome failed, write the message as a short
Markdown list, one point per line: what you changed, what still fails and why, what is not done, and
what you need the user to decide.`;

function bullets(lines: readonly string[]): string {
  return lines.map(line => `- ${line}`).join('\n');
}

function checkOutcome(result: CheckResult): string {
  if (result.passed) return 'passed';
  return result.timedOut ? 'FAILED (timed out)' : `FAILED (exit ${result.exitCode ?? 'none'})`;
}

function checkList(checks: readonly CheckDefinition[]): string {
  return bullets(checks.map(check => `${check.name}: \`${check.command}\``));
}

export function specPrompt(input: {
  setup?: string | null;
  request: string;
  specPath: string;
  previousSpecPath: string | null;
  feedback: string | null;
  rejection: string | null;
  /** Questions the user answered for earlier attempts; a fresh writer must not ask them again. */
  answered: readonly { question: string; answer: string }[];
}): string {
  const answered = input.answered.length
    ? `\nQuestions the user already answered (do not ask them again):\n${input.answered
        .map(item => `- Q: ${item.question}\n  A: ${item.answer}`)
        .join('\n')}\n`
    : '';
  const revision = input.previousSpecPath
    ? `\nThis is a revision. The previous spec is at ${input.previousSpecPath}.${
        input.feedback ? `\nThe user's feedback:\n${input.feedback}\n` : ''
      }${input.rejection ? `\nThe previous file could not be used: ${input.rejection}\n` : ''}${answered}`
    : '';
  return `ROLE: spec writer.

Repository preparation: ${input.setup ? `Grampus already ran ${input.setup} successfully. Do not repeat dependency installation in each check.` : 'No setup command was configured. If prerequisites are missing, report the environment problem explicitly; do not call it a behavioural failure.'}

TARGET: this repository, read-only. The request:
${input.request}
${revision}
CHANGE: write a spec for the request to ${input.specPath}. Investigate the relevant code, current
behaviour and conventions first.

CONSTRAINTS:
- Resolve ambiguities that would materially change the result before writing. Ask every question with
  the orchestration ask command and wait for its answer: the user answers through Grampus and may not
  be reading this chat, so a question written only here goes unanswered. Propose a default answer
  with each question. Do not ask about minor details; choose a default and list it under Assumptions.
- Do not edit repository files, commit or change branches. Write only the spec file.
- Keep the spec proportional to the task. Criteria describe behaviour, not implementation.

${specFormat}

ACCEPTANCE: the spec file exists in this format. Then send worker_done with --outcome succeeded and
--report-path ${input.specPath}. Use --outcome failed only if no useful spec is possible, and say why.`;
}

export function specReviewPrompt(input: {
  request: string;
  specPath: string;
  reportPath: string;
  /** The spec's checks as Grampus ran them on the current commit, with failing log tails; null if they could not run. */
  checksBefore: readonly { result: CheckResult; excerpt: string | null }[] | null;
}): string {
  const before = input.checksBefore
    ? `Grampus ran the spec's checks on the current commit, before any change:
${input.checksBefore.map(({ result, excerpt }) => `- ${result.name}: ${checkOutcome(result)}${excerpt ? `. Log tail:\n${excerpt}` : ''}`).join('\n')}
A check may fail here only because the behaviour is missing, for example because it runs tests the
builder will add. A check that fails for any other reason (no tests ran, a missing tool or dependency,
a command that cannot work) can never prove its criteria, and is blocking. A check that already passes
shows no regression but not the new behaviour.`
    : `Grampus could not run the spec's checks on the current commit; judge the commands by reading them.`;
  return `ROLE: spec reviewer, independent of the spec writer.

TARGET: the spec at ${input.specPath} and this repository, read-only.
Original user request:
${input.request}

CHANGE: review the spec before the user approves it and write a report to ${input.reportPath}.
Look for: ambiguity that would change the result, missing edge cases, criteria that no check
exercises, checks that cannot prove their criteria or are likely slow or flaky, and scope beyond
the request. Severity "blocking" means it must be resolved before building; everything else is a note.
Compare the acceptance mapping against the original request, not just the provisional approach.
Trace each scenario through production entry points and name any mocked boundary that hides the
requested behaviour. A central requested outcome missing from the spec is a coverage gap.

${before}

CONSTRAINTS: do not edit any file except the report. Do not repeat the spec back.

${reportFormat}
Also include "requestCoverage": {"verdict":"covered" | "gaps" | "unknown", "rationale":"how the spec accounts for the original request, including any omitted outcomes"}.

ACCEPTANCE: the report file exists as valid JSON. Then send worker_done with --outcome succeeded and
--report-path ${input.reportPath}.`;
}

export function testsFirstPrompt(input: {
  specPath: string;
  checks: readonly CheckDefinition[];
  reportPath?: string;
}): string {
  return `ROLE: acceptance test writer.

TARGET: this repository and the approved spec at ${input.specPath}.

CHANGE: turn the spec's acceptance criteria and examples into automated tests that the approved
checks run:
${checkList(input.checks)}

CONSTRAINTS:
- Write tests only. Do not implement the feature.
- The tests must fail now, for the reason that the feature is missing, and pass once it exists.
- Follow the project's test conventions. Commit the tests on the current branch, leave no
  uncommitted files, and do not push, change branches or rewrite history.
- Prefer existing public interfaces and observable behaviour, avoiding assumptions about new internal
  methods or data structures. This lets different builders implement the same acceptance tests.
- Once you commit them, these files are protected: the builder cannot change them.
${input.reportPath ? `\nWrite a report to ${input.reportPath}, with JSON {"failures":[{"check":"approved check name","file":"repository-relative changed test file","test":"exact runner-reported test name","criterion":"criterion this failure demonstrates","expectedOutput":"exact short assertion output"}]}. Run the checks and quote actual failure output. Missing tools, failed imports and broken test harnesses are not behavioural failures. Use a runner reporter that prints named failures, file locations and assertion diagnostics (for example Node TAP, Vitest, Jest or pytest). Grampus independently reruns the checks and requires the named test and assertion in the same failure section of the full log. Include every intended failing acceptance test; a filename, suite failure or arbitrary printed text alone is insufficient.` : ''}

ACCEPTANCE: one or more commits that add the tests. Then send worker_done with --outcome succeeded
and --files-modified listing the test files.`;
}

export function buildPrompt(input: {
  specPath: string;
  checks: readonly CheckDefinition[];
  protectedPaths: readonly string[];
}): string {
  return `ROLE: builder.

TARGET: this repository and the approved spec at ${input.specPath}. Read the whole spec first.

CHANGE: implement the spec so every acceptance criterion holds and these checks pass:
${checkList(input.checks)}

CONSTRAINTS:
- Commit your work on the current branch with clear messages, and leave no uncommitted or untracked
  files. Do not push, change branches, amend or rebase commits you did not make, or edit Git config.
- Do not delete, skip or weaken tests to make checks pass. Grampus checks for this.${
    input.protectedPaths.length ? `\n- Do not change these protected paths:\n${bullets(input.protectedPaths)}` : ''
  }
- Keep the change focused on the spec and follow the repository's conventions.
- If the spec is contradictory or impossible, stop and report worker_done with --outcome failed,
  explaining why, rather than working around it.

ACCEPTANCE: Grampus runs the checks itself at your final commit and an independent reviewer reads the
diff against the spec. When you have committed, send worker_done with --outcome succeeded.
${failureReport}`;
}

export interface RepairProblems {
  failedChecks: { result: CheckResult; excerpt: string; failedAtBase: boolean }[];
  violations: string[];
  findings: Finding[];
  /** What the user said with each `continue` so far, oldest first. */
  guidance: string[];
}

export function repairPrompt(input: {
  specPath: string;
  checks: readonly CheckDefinition[];
  protectedPaths: readonly string[];
  round: number;
  problems: RepairProblems;
}): string {
  return `ROLE: builder, repair round ${input.round}.

TARGET: this repository, the approved spec at ${input.specPath} and the problems below, found at
your last commit.

CHANGE: fix these problems so every criterion holds and the checks pass.

${describeProblems(input.problems)}

CONSTRAINTS:
- Do not argue with a finding. If you believe one is wrong, leave that code and add a test that
  demonstrates the correct behaviour; a test settles it.
- Commit your work on the current branch and leave no uncommitted or untracked files. Do not push,
  change branches, amend or rebase commits you did not make.
- Do not delete, skip or weaken tests.${
    input.protectedPaths.length ? `\n- Do not change these protected paths:\n${bullets(input.protectedPaths)}` : ''
  }

Checks Grampus runs:
${checkList(input.checks)}

ACCEPTANCE: when you have committed, send worker_done with --outcome succeeded. Use --outcome failed
if the problems cannot be fixed within the spec, and say why.
${failureReport}`;
}

function describeProblems(problems: RepairProblems): string {
  const sections: string[] = [];
  if (problems.guidance.length)
    sections.push(
      `GUIDANCE FROM THE USER, oldest first. All of it still applies; where two disagree, the later wins:\n${bullets(problems.guidance)}`,
    );
  if (problems.violations.length) sections.push(`INTEGRITY PROBLEMS:\n${bullets(problems.violations)}`);
  for (const failed of problems.failedChecks)
    sections.push(
      `FAILED CHECK "${failed.result.name}" (\`${failed.result.command}\`, exit ${failed.result.exitCode ?? 'none'}${
        failed.result.timedOut ? ', timed out' : ''
      }${failed.failedAtBase ? ', also failed before your change' : ''}). Log tail:\n${failed.excerpt}`,
    );
  for (const finding of problems.findings)
    sections.push(
      `REVIEW FINDING: ${finding.title}\nLocation: ${finding.file ?? '?'}:${finding.line ?? '?'}\nScenario: ${
        finding.scenario ?? ''
      }${finding.criterion ? `\nCriterion: ${finding.criterion}` : ''}${finding.detail ? `\n${finding.detail}` : ''}`,
    );
  return sections.join('\n\n');
}

export function reviewPrompt(input: {
  request: string;
  guidance: readonly string[];
  specPath: string;
  baseSha: string;
  sha: string;
  reportPath: string;
  results: readonly CheckResult[];
  modifiedTests: readonly string[];
  modifiedCheckConfig: readonly string[];
  previousFindings: readonly Finding[];
  roundFromSha?: string;
  acceptanceTests?: readonly string[];
  testBaseline?: readonly string[];
}): string {
  const results = bullets(
    input.results.map(
      result =>
        `${result.name}: ${result.passed ? 'passed' : 'FAILED'}${result.flaky ? ' (flaky: passed on rerun)' : ''}`,
    ),
  );
  const previous = input.previousFindings.length
    ? `\nThe previous round raised these blocking findings; check whether each is resolved:\n${bullets(
        input.previousFindings.map(finding => `${finding.title} (${finding.file ?? '?'}:${finding.line ?? '?'})`),
      )}\n`
    : '';
  return `ROLE: code reviewer, independent of the builder.

TARGET: the change ${input.baseSha.slice(0, 12)}..${input.sha.slice(0, 12)} in this repository
(\`git diff ${input.baseSha} ${input.sha}\`), against the approved spec at ${input.specPath}.
Original user request:
${input.request}
${input.guidance.length ? `User guidance, oldest first:\n${bullets(input.guidance)}` : ''}
${input.roundFromSha ? `\nThe current round alone is \`git diff ${input.roundFromSha} ${input.sha}\`. Judge coverage using the complete task diff above, including tests committed before the builder started.` : ''}
${input.acceptanceTests?.length ? `\nAcceptance tests committed before implementation and protected afterwards:\n${bullets(input.acceptanceTests)}` : ''}
${input.testBaseline?.length ? `\nPre-implementation test evidence:\n${bullets(input.testBaseline)}\nConfirm the claimed missing behaviour caused the failure; unknown evidence does not establish a red phase.` : ''}

Check results at ${input.sha.slice(0, 12)}, run by Grampus:
${results}${
    input.modifiedTests.length
      ? `\nExisting tests this change modified; check they were not weakened:\n${bullets(input.modifiedTests)}`
      : ''
  }${
    input.modifiedCheckConfig.length
      ? `\nFiles that configure how the checks run, changed by this change (runner, build or lint settings, or
files a check command names). A change here that makes a check pass without the behaviour it tests, for
example by ignoring an exit code, skipping tests or relaxing a rule, is blocking:\n${bullets(input.modifiedCheckConfig)}`
      : ''
  }
${previous}
CHANGE: write a review report to ${input.reportPath}.

CONSTRAINTS:
- Read-only: do not edit, commit or check out anything except writing the report.
- Evaluate implementation against the spec AND whether the spec and tests fulfil the original request.
  Follow the requested action through production wiring. An injected roster, mocked transport or unused
  helper does not prove the corresponding real journey. Use the smallest appropriate executable seam.
- A finding is "blocking" only if the change is incorrect or misses a requested outcome or spec criterion, and only with a
  file, a line and a concrete failing scenario. Grampus downgrades blocking findings without them to notes.
- Style, naming, polish and speculative risks are notes. Do not invent gaps to have something
  to report; "approve" with no findings is a good review when the change is right.

${reportFormat}
Also include both:
"requestCoverage": {"verdict":"covered" | "gaps" | "unknown", "rationale":"assessment of the original request, including omissions in the spec"},
"coverage": [{"acceptanceId":"id from the approved acceptance mapping", "status":"verified" | "unverified",
 "evidence":"specific test, assertion and driver check that exercise the outcome", "limitations":["remaining gaps or relevant mock boundaries"]}].
Name EVERY approved acceptance id exactly once. Mark an outcome unverified if the evidence cannot
establish it, even if all commands passed. A missing requested outcome cannot be dismissed as extra scope
merely because the spec overlooked it. Do not invent coverage or require unrelated full-system tests.

ACCEPTANCE: the report file exists as valid JSON. Then send worker_done with --outcome succeeded and
--report-path ${input.reportPath}.`;
}

export function polishPrompt(input: {
  specPath: string;
  baseSha: string;
  sha: string;
  checks: readonly CheckDefinition[];
  protectedPaths: readonly string[];
  reviewed: boolean;
  reportPath: string;
}): string {
  return `ROLE: polisher.

TARGET: the change ${input.baseSha.slice(0, 12)}..${input.sha.slice(0, 12)} in this repository
(\`git diff ${input.baseSha} ${input.sha}\`), which implements the approved spec at ${input.specPath}.
Its checks pass${input.reviewed ? ' and a reviewer approved it' : ''}.

CHANGE: polish the task's code for readability, maintainability, consistency, simplicity and better
naming while preserving behaviour. Inspect it first and explain the improvement each edit makes.
These are valid benefits in their own right; no hypothetical future edit is needed to justify them.
Look for:
- unclear names, inconsistent terminology or presentation, and code that is harder to read than it needs to be;
- code that does what the repository already has a helper for: use the helper;
- duplication within the change;
- abstractions, options, parameters, configuration or error handling the spec does not need;
- dead code, unused exports, leftover debugging and comments that restate the code.
- confusing control flow or redundant state that makes an actual rule harder to maintain.
Extract shared code only when it represents the same rule or responsibility and reduces maintenance
effort. Similar-looking code alone is not enough. Do not introduce generic helpers speculatively.

CONSTRAINTS:
- Keep behaviour exactly as it is: every acceptance criterion still holds and these checks still pass:
${checkList(input.checks)}
- Focus on the task's change. At most ${polishLimits.adjacentFiles} adjacent files may be edited, only when necessary to complete a
  specific improvement. Explain each in the report. Leave broader architectural cleanup for another task.
- Do not polish tests. Change a test only where code you polished requires it, such as an import,
  a renamed function or a signature, and keep every assertion and case.
- Do not change how checks run: runner, build or lint settings, or scripts a check names.${
    input.protectedPaths.length ? `\n- Do not change these protected paths:\n${bullets(input.protectedPaths)}` : ''
  }
- Standalone naming, readability and consistency improvements are welcome. Follow the repository's
  conventions and explain what improves; do not churn code solely to impose a personal preference.
  If you find no useful improvement, commit nothing and report an empty improvements list.
- Commit your work on the current branch and leave no uncommitted or untracked files. Do not push,
  change branches, amend or rebase commits you did not make.

Write a report to ${input.reportPath}. Use this JSON shape:
{"summary":"What improved, or why no worthwhile change was found","improvements":[{"category":"naming|duplication|structure|cleanup|consistency","files":["repo-relative/path"],"problem":"Readability, naming, consistency or maintenance issue","benefit":"How the code becomes clearer, simpler, more consistent or easier to maintain","adjacentReason":null}]}
The report is runtime evidence in this worktree's Git metadata, outside product source. Write only the
specified report there. Do not add, force-add or commit reports, and do not alter other Git metadata.
Use exactly one category per item. Set adjacentReason to an explanation for edits outside the original
change. Cover every edited file. For a successful no-op, improvements is empty. More edits or fewer
lines are not a goal. Inspect affected callers and run relevant checks beyond the approved checks when
adjacent edits require them; explain any verification limitation in the report.

ACCEPTANCE: Grampus runs the checks at your final commit${input.reviewed ? ' and a reviewer reads your diff' : ''}.
If anything fails, your commits are discarded and the change stays as it was. When you have committed,
or decided nothing needs polishing, send worker_done with --outcome succeeded.`;
}

export function polishReviewPrompt(input: {
  specPath: string;
  fromSha: string;
  sha: string;
  reportPath: string;
  results: readonly CheckResult[];
  modifiedTests: readonly string[];
  polishReportPath: string;
}): string {
  return `ROLE: code reviewer, independent of the polisher.

TARGET: the polish ${input.fromSha.slice(0, 12)}..${input.sha.slice(0, 12)} in this repository
(\`git diff ${input.fromSha} ${input.sha}\`). It polishes a change that was already verified against
the approved spec at ${input.specPath}, and must not change behaviour.

Check results at ${input.sha.slice(0, 12)}, run by Grampus:
${bullets(input.results.map(result => `${result.name}: ${result.passed ? 'passed' : 'FAILED'}`))}${
    input.modifiedTests.length
      ? `\nTests the polish modified. A test may change only to follow the polished code (an import,
a name, a signature); a removed or weakened assertion or case is blocking:\n${bullets(input.modifiedTests)}`
      : ''
  }

CHANGE: write a review report to ${input.reportPath}.
Read the worker's claimed improvements at ${input.polishReportPath}, then assess the code independently.

CONSTRAINTS:
- Read-only: do not edit, commit or check out anything except writing the report.
- A finding is "blocking" only if the polish changes behaviour, breaks a spec criterion or
  weakens a test, and only with a file, a line and a concrete failing scenario.
- Independently assess the benefit: readability, maintainability, consistency, simpler code and better
  naming all count, including standalone improvements. A hypothetical future edit is not required.
  Look for clearer domain names, fewer representations of a rule, simpler control flow, justified reuse
  or removal of unused code. Distinguish useful polish from personal preference, speculative abstractions
  and unrelated cleanup. Check that every adjacent edit is necessary and bounded, and inspect affected
  callers. Preserve improvements worth keeping; preserving behaviour alone is not evidence of a benefit.
- Use "approve" only when you are confident behaviour is unchanged. Any other verdict discards the
  polish and keeps the change as it was, which is safe.

${reportFormat}
Add a required "maintenance" field alongside verdict, summary and findings:
{"verdict":"worth-keeping|no-benefit|unknown","rationale":"Specific benefit or reason to discard"}.
Choose one maintenance verdict. Grampus keeps the pass only with behaviour verdict approve AND
maintenance verdict worth-keeping. If verification of affected code is insufficient, use unknown.

ACCEPTANCE: the report file exists as valid JSON. Then send worker_done with --outcome succeeded and
--report-path ${input.reportPath}.`;
}
