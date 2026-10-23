// Resolve repository-grounded implementation questions without inventing user product decisions.
import { z } from 'zod';
import { reviewLimits } from '../config/limits.js';
import { git, headSha } from '../git/git.js';
import { OrcaError } from '../orca/client.js';
import type { DriverCore } from './driver-core.js';
import { deliveryPolicy } from './delivery.js';
import { isOpen } from './state.js';
import { readWorkerFile, workerFile } from './workspace-files.js';

const assessmentSchema = z
  .object({
    disposition: z.enum(['answer', 'user']),
    body: z.string().trim().min(1).max(reviewLimits.textLength),
    references: z.array(z.string().trim().min(1)).max(reviewLimits.findings),
  })
  .strict();

/** Called by the inbox owner, with re-entrancy suppressed while its resolver worker runs. */
export async function resolveImplementationQuestions(core: DriverCore): Promise<void> {
  if (deliveryPolicy(core).mode !== 'unattended') return;
  for (const [messageId, question] of core.state.questions) {
    if (!isOpen(question) || question.key?.startsWith('question:')) continue;
    let assessed = core.events.findLast(event => event.type === 'question.assessed' && event.messageId === messageId);
    if (!assessed) {
      const used = core.state.questionAssessments.size;
      assessed =
        used >= deliveryPolicy(core).questionResolutions
          ? core.record({
              type: 'question.assessed',
              messageId,
              sha: null,
              specVersion: core.state.specs.at(-1)?.version ?? null,
              disposition: 'user',
              body: 'The automatic question allowance is exhausted; this question needs your decision.',
              references: [],
            })
          : await assessQuestion(core, messageId, question.body || question.subject);
    }
    if (assessed.type !== 'question.assessed' || assessed.disposition !== 'answer' || !isOpen(question)) continue;
    try {
      await core.mutate(() => core.orca.reply(messageId, assessed.body, core.requestId(`question:${messageId}:reply`)));
      core.record({ type: 'question.answered', messageId, body: assessed.body });
    } catch (error) {
      if (!(error instanceof OrcaError)) throw error;
      core.record({
        type: 'question.assessed',
        messageId,
        sha: assessed.sha,
        specVersion: assessed.specVersion,
        disposition: 'user',
        body: `Automatic reply was refused: ${error.message}`,
        references: [],
      });
    }
  }
}

async function assessQuestion(core: DriverCore, messageId: string, question: string) {
  const cwd = core.state.workspace?.path;
  if (!cwd) throw new Error('Question resolution needs a workspace.');
  const key = `question:${messageId}`;
  const reportPath = workerFile(cwd, key, 'report.json');
  const before = await snapshot(cwd);
  const binding = { sha: await headSha(cwd), specVersion: core.state.specs.at(-1)?.version ?? null };
  const closed = () => {
    const current = core.state.questions.get(messageId);
    return !current || !isOpen(current);
  };
  const settled = await core.runOptionalStage(
    {
      key,
      stage: 'question',
      round: 0,
      title: `Question triage: ${core.state.title}`,
      launch: { assignment: core.state.recipe.specReview ?? core.state.recipe.spec },
      spec: () =>
        `ROLE: read-only implementation question resolver.\nOriginal request: ${core.state.request}\nQuestion: ${question}\nInspect repository conventions and existing code. Answer only implementation questions whose answer follows from the request and repository. Do not choose product behaviour, expand scope, waive checks, authorise protected-test changes, merge, push or deploy. If authority or intent is unclear, disposition is user. Do not ask another worker or the user. Do not edit any repository files. Write a JSON report to ${reportPath}.\nExact schema: {"disposition":"answer"|"user","body":"concise answer or precise product decision","references":["existing repository-relative file"]}. An answer must cite at least one existing tracked file supporting it.`,
    },
    closed,
  );
  if (closed())
    return core.record({
      type: 'question.assessed',
      messageId,
      ...binding,
      disposition: 'user',
      body: 'The question was already answered or closed.',
      references: [],
    });
  if ((await snapshot(cwd)) !== before) throw new Error('Question resolver changed the candidate.');
  let assessment: z.infer<typeof assessmentSchema>;
  try {
    if ('error' in settled || settled.outcome === 'failed')
      throw new Error('Question resolver did not produce a reliable answer.');
    assessment = assessmentSchema.parse(JSON.parse(readWorkerFile(reportPath) ?? 'null'));
    if (assessment.disposition === 'answer') {
      const paths = new Set((await git(cwd, ['ls-files'])).trim().split(/\r?\n/));
      if (!assessment.references.length || assessment.references.some(path => !paths.has(path)))
        throw new Error('Answer lacks existing repository references.');
    }
  } catch (error) {
    assessment = { disposition: 'user', body: (error as Error).message, references: [] };
  }
  return core.record({ type: 'question.assessed', messageId, ...binding, ...assessment });
}

async function snapshot(cwd: string): Promise<string> {
  return `${await headSha(cwd)}\n${await git(cwd, ['diff', 'HEAD', '--binary'])}\n${await git(cwd, ['status', '--porcelain'])}`;
}
