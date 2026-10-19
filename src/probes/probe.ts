// Live subscription probe of one provider adapter through the CLI: questions and answers across a
// controller restart, context retention, a structured review, interruption and resumption. Each turn
// runs in a fresh controller process; nothing in this probe is used by the controller itself.
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sessionSchema } from '../persistence/records.js';
import { turnResultSchema, type TurnResult } from '../providers/reply-schema.js';

const provider = process.argv[2] ?? '';
if (provider !== 'codex' && provider !== 'claude')
  throw new Error('Usage: npm run probe -- codex|claude (uses your subscription)');
const directory = mkdtempSync(join(tmpdir(), `grampus-${provider}-probe-`));
const database = join(directory, 'grampus.sqlite');
const cli = fileURLToPath(new URL('../cli.js', import.meta.url));

/** Runs one CLI command in a fresh controller process and validates its JSON output against `schema`. */
async function run<S extends z.ZodType>(schema: S, ...args: string[]): Promise<z.output<S>> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [cli, '--db', database, ...args],
      { timeout: 150_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // 130 is the CLI's interrupted exit; an interrupted turn still prints its JSON result.
        if (error && error.code !== 130) {
          reject(new Error(`${args[0]} failed: ${stdout || error.message}`));
          return;
        }
        try {
          resolve(schema.parse(JSON.parse(stdout)));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
    child.stdin?.end();
  });
}

async function main(): Promise<void> {
  console.log(
    JSON.stringify({
      provider,
      database,
      note: 'Live subscription probe; each turn runs in a fresh controller process',
    }),
  );
  const session = await run(sessionSchema, 'session-new', provider, '--cwd', directory);
  async function turn(prompt: string, interrupt = false): Promise<TurnResult> {
    const file = join(directory, 'prompt.txt');
    writeFileSync(file, prompt);
    const response = await run(
      z.object({ result: turnResultSchema, session: sessionSchema }),
      'session-send',
      session.id,
      '--prompt-file',
      file,
      ...(interrupt ? ['--interrupt-after-ms', '250'] : []),
    );
    console.log(
      JSON.stringify({
        status: response.result.status,
        phase: response.session.phase,
        model: response.session.model,
        error: response.result.error,
      }),
    );
    return response.result;
  }
  const question = await turn(
    'Protocol fixture: ask exactly one structured question with id label asking which label I want. Offer cobalt and amber. Do not choose for me; end this turn with kind question.',
  );
  if (question.status !== 'completed' || question.reply?.kind !== 'question' || question.reply.questions.length !== 1)
    throw new Error('Question probe failed');
  const label = `reef-${randomUUID().slice(0, 8)}`;
  const answers = join(directory, 'answers.json');
  const asked = question.reply.questions[0];
  if (!asked) throw new Error('Question probe returned no question');
  writeFileSync(answers, JSON.stringify({ [asked.id]: label }));
  const answered = await run(z.object({ result: turnResultSchema }), 'session-answer', session.id, answers);
  if (answered.result.status !== 'completed') throw new Error(`Answer probe failed: ${answered.result.error}`);
  console.log(JSON.stringify({ check: 'question and answer across controller restart', passed: true }));
  const review = await turn(
    'Review this supplied fixture only: function add(a, b) { return a - b; }. Requirement: add(2, 3) must return 5. Return kind review with a blocking finding and a concrete failing example. Include the label I selected earlier in your text.',
  );
  if (
    review.status !== 'completed' ||
    review.reply?.kind !== 'review' ||
    !review.reply.text.includes(label) ||
    !review.reply.findings.some(f => f.severity === 'blocking')
  )
    throw new Error('Context/review probe failed');
  console.log(JSON.stringify({ check: 'context and structured review after reconnect', passed: true }));
  const interrupted = await turn(
    'For an interruption fixture, produce a long explanation of sorting algorithms, at least 2000 words in text. Use kind message.',
    true,
  );
  if (interrupted.status !== 'interrupted') throw new Error('Interrupt was not confirmed');
  const resumed = await turn(
    'What exact label did I choose earlier? Return kind message and put only the exact label in text.',
  );
  if (resumed.status !== 'completed' || resumed.reply?.text.trim() !== label)
    throw new Error('Resume after interruption lost context');
  const summary = {
    provider,
    sessionId: session.id,
    database,
    passed: true,
    checks: [
      'question',
      'answer',
      'controller restart',
      'context retention',
      'structured review fixture',
      'interrupt',
      'resume after interrupt',
    ],
    usage: resumed.usage,
  };
  writeFileSync(join(directory, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Evidence retained at ${database}`);
  process.exitCode = 1;
});
