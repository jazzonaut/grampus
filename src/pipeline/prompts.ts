// Task specs given to Orca workers. Orca prepends its own preamble (task and dispatch ids, the exact
// `worker_done` and `ask` commands); these texts say what to do. Each follows Orca's task-spec contract:
// target, change, constraints, ownership and observable acceptance. Prompt text is a contract with the
// agents: change it deliberately, and expect measured results to move when it does.
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
{"checks": [{"name": "unit tests", "command": "npm test -- src/export.test.ts", "timeoutSeconds": 600}], "protected": []}
\`\`\`

- "checks": commands run from the repository root, non-interactively, that exit 0 only when the
  criteria hold. Prefer the project's existing commands and narrow them to the relevant tests. Each
  must be deterministic and finish within its timeout. They may name tests the builder will add; say
  under the criteria which tests are expected.
- "protected": repository globs the builder must not change (usually empty).`;

const reportFormat = `Write the report as JSON:

{"verdict": "approve" | "changes" | "unknown",
 "summary": "<two or three sentences>",
 "findings": [{"severity": "blocking" | "note", "title": "...", "file": "path", "line": 12,
               "criterion": "<quoted criterion, if any>", "scenario": "<inputs or steps that go wrong>",
               "detail": "..."}]}

Use "unknown" when you cannot decide; it is a valid answer and better than a guess.`;

function bullets(lines: readonly string[]): string {
  return lines.map(line => `- ${line}`).join('\n');
}

function checkList(checks: readonly CheckDefinition[]): string {
  return bullets(checks.map(check => `${check.name}: \`${check.command}\``));
}

export function specPrompt(input: {
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

export function specReviewPrompt(input: { specPath: string; reportPath: string }): string {
  return `ROLE: spec reviewer, independent of the spec writer.

TARGET: the spec at ${input.specPath} and this repository, read-only.

CHANGE: review the spec before the user approves it and write a report to ${input.reportPath}.
Look for: ambiguity that would change the result, missing edge cases, criteria that no check
exercises, checks that cannot prove their criteria or are likely slow or flaky, and scope beyond
the request. Severity "blocking" means it must be resolved before building; everything else is a note.

CONSTRAINTS: do not edit any file except the report. Do not repeat the spec back.

${reportFormat}

ACCEPTANCE: the report file exists as valid JSON. Then send worker_done with --outcome succeeded and
--report-path ${input.reportPath}.`;
}

export function testsFirstPrompt(input: { specPath: string; checks: readonly CheckDefinition[] }): string {
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
- Once you commit them, these files are protected: the builder cannot change them.

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
diff against the spec. When you have committed, send worker_done with --outcome succeeded.`;
}

export interface RepairProblems {
  failedChecks: { result: CheckResult; excerpt: string; failedAtBase: boolean }[];
  violations: string[];
  findings: Finding[];
  guidance: string | null;
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
if the problems cannot be fixed within the spec, and say why.`;
}

function describeProblems(problems: RepairProblems): string {
  const sections: string[] = [];
  if (problems.guidance) sections.push(`GUIDANCE FROM THE USER:\n${problems.guidance}`);
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
  specPath: string;
  baseSha: string;
  sha: string;
  reportPath: string;
  results: readonly CheckResult[];
  modifiedTests: readonly string[];
  previousFindings: readonly Finding[];
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

Check results at ${input.sha.slice(0, 12)}, run by Grampus:
${results}${
    input.modifiedTests.length
      ? `\nExisting tests this change modified; check they were not weakened:\n${bullets(input.modifiedTests)}`
      : ''
  }
${previous}
CHANGE: write a review report to ${input.reportPath}.

CONSTRAINTS:
- Read-only: do not edit, commit or check out anything except writing the report.
- A finding is "blocking" only if the change is incorrect or misses a spec criterion, and only with a
  file, a line and a concrete failing scenario. Grampus downgrades blocking findings without them to notes.
- Style, naming, simplification and speculative risks are notes. Do not invent gaps to have something
  to report; "approve" with no findings is a good review when the change is right.

${reportFormat}

ACCEPTANCE: the report file exists as valid JSON. Then send worker_done with --outcome succeeded and
--report-path ${input.reportPath}.`;
}
