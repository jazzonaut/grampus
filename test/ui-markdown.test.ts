import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function dashboard() {
  const listeners = new Map<string, (event: unknown) => Promise<void>>();
  const app = { innerHTML: '', querySelectorAll: () => [], addEventListener: (type: string, listener: (event: unknown) => Promise<void>) => listeners.set(type, listener) };
  const context = createContext({
    Event,
    document: { querySelector: (selector: string) => selector === '#app' ? app : { addEventListener() {} }, getElementById: () => null },
    location: { hash: '' }, sessionStorage: { getItem: () => null, setItem() {} },
  });
  context.window = context;
  for (const file of ['node_modules/markdown-it/dist/browser/markdown-it.umd.min.js', 'src/ui/markdown.js', 'src/ui/app.js']) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    // Load the production renderer and event handlers without starting polling.
    runInContext(source.split(/\r?\nrefresh\(true\)\.catch\(showError\);/)[0]!, context);
  }
  return { app, context, listeners, render: (text: string) => runInContext(`window.GrampusMarkdown.render(${JSON.stringify(text)})`, context) as string };
}

test('dashboard Markdown formats agent explanations, nested lists, tables and code', () => {
  const { render } = dashboard();
  const html = render("## What's already in place\n\n- The registry uses `createEncoders`.\n  - **PDF** returns a `Uint8Array`.\n- Fonts use *embedFiles*.\n\n```js\nconst limit = 14_400;\n```\n\n| Format | Encoder |\n| --- | --- |\n| PDF | pdfkit |\n\n> Keep the existing scale.");
  assert.match(html, /<h2>What's already in place<\/h2>/);
  assert.match(html, /<code>createEncoders<\/code>/);
  assert.match(html, /<ul>[\s\S]*<ul>[\s\S]*<strong>PDF<\/strong>/);
  assert.match(html, /<em>embedFiles<\/em>/);
  assert.match(html, /<pre><code class="language-js">const limit = 14_400;/);
  assert.match(html, /<table>/);
  assert.match(html, /<blockquote>/);
});

test('the planning sidebar uses saved task names and escapes them, retaining the description fallback', () => {
  const { context } = dashboard();
  context.items = [
    { id: 'named', title: 'Fix <login> & logout', config: { request: 'Please could you look into a very long description' }, session: { phase: 'running' } },
    { id: 'legacy', config: { request: 'Older description' }, session: { phase: 'idle' } },
  ];
  const html = runInContext('state.kickoffs = items; nav()', context) as string;
  assert.match(html, /Fix &lt;login&gt; &amp; logout/); assert.match(html, /Older description/);
  assert.doesNotMatch(html, /Please could you|<login>/);
});

test('plan revisions, repair budgets and structured acceptance remain reviewable and escaped', () => {
  const { context } = dashboard();
  context.view = { state: { status: 'blocked', plan: { brief: { title: '</textarea><script>bad</script>', outcome: 'New output', plan: 'Small change' }, reviewPolicy: { repairRounds: 2, arbitrator: { provider: 'codex', model: 'fixture', timeoutMs: 120000 } } } } };
  const html = runInContext('revisionCard(view) + reviewPolicyCard(view.state.plan) + usageCard({usageSummary:["codex: 240 (partial)"]})', context) as string;
  assert.match(html, /revision-form/); assert.match(html, /Repair rounds/); assert.match(html, /Fresh arbitration: codex/);
  assert.match(html, /240 \(partial\)/); assert.match(html, /&lt;\/textarea&gt;/); assert.doesNotMatch(html, /<script>/);
  runInContext('view.state.owner = {token:"owned"}', context);
  assert.equal(runInContext('revisionCard(view)', context), '');
});

test('agent Markdown escapes HTML, blocks executable links and avoids image requests', () => {
  const { render } = dashboard();
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[run](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29) [file](file:///C:/secret) [app](vscode:open)\n\n![remote image](https://example.com/track.png)\n\n[Spec](https://example.com/spec "Specification")');
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|file|vscode):/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /remote image/);
  assert.match(html, /href="https:\/\/example.com\/spec" title="Specification" target="_blank" rel="noopener noreferrer"/);
});

test('blocked file scopes explain why unchanged retry repeats the failure', () => {
  const { context } = dashboard();
  context.view = { state: { status: 'blocked', stage: 'scope' } };
  const html = runInContext('taskAction(view)', context) as string;
  assert.match(html, /revise this task’s plan/); assert.match(html, /same approved scope/);
});

test('question suggestions render inline Markdown and copy the exact editable answer without submitting', async () => {
  const { context, listeners } = dashboard();
  const choice = '**Same as JNow** (`pdfkit-latest` 2.0.15); install allowed';
  context.questions = [{ id: 'deps', prompt: 'Which **dependencies**?', choices: [choice, '[spec](https://example.com)'] }];
  const html = runInContext('questionsForm(questions, true)', context) as string;
  assert.match(html, /<strong>dependencies<\/strong>/);
  assert.match(html, /<li><button type="button" data-answer-target="answer-0"/);
  assert.match(html, /<strong>Same as JNow<\/strong>/);
  assert.match(html, /<code>pdfkit-latest<\/code>/);
  assert.doesNotMatch(html, /<a\b|<p>.*Same as JNow/);
  let focused = false;
  const field = { value: '', focus() { focused = true; }, setSelectionRange() {}, dispatchEvent() {} };
  const button = {
    disabled: false, dataset: { answerTarget: 'answer-0', answerValue: choice },
    textContent: 'Same as JNow (pdfkit-latest 2.0.15); install allowed',
    form: { querySelector: (selector: string) => { assert.equal(selector, '#answer-0'); return field; } },
  };
  await listeners.get('click')!({ target: { closest: () => button } });
  assert.equal(field.value, choice);
  assert.equal(focused, true);
  field.value += '; preserve my edits';
  assert.match(field.value, /preserve my edits$/);
});

test('proposed plans render narrative Markdown while command arguments stay literal', () => {
  const { context } = dashboard();
  context.plan = {
    brief: { title: 'PDF export', outcome: '**Export PDF**', criteria: ['Uses `Uint8Array`'], plan: '## Approach\n\n- Reuse the scale\n- Embed fonts' },
    workspace: { repo: 'C:/repo', base: 'abc', path: 'C:/work' },
    implementation: { provider: 'claude', timeoutMs: 300000 }, review: { provider: 'codex', timeoutMs: 300000 },
    slices: [{ scope: { files: ['src/export.ts'] }, validation: { name: 'Tests', file: 'node', args: ['**literal** <tag>'], timeoutMs: 1000 }, acceptance: { name: 'PDF', file: 'node', args: [], timeoutMs: 1000, expectedStdout: 'ok\n' }, mode: 'commit', message: 'Add PDF' }],
  };
  const html = runInContext('planCard(plan)', context) as string;
  assert.match(html, /<strong>Export PDF<\/strong>/);
  assert.match(html, /<code>Uint8Array<\/code>/);
  assert.match(html, /<h2>Approach<\/h2>/);
  assert.match(html, /<li>Reuse the scale<\/li>/);
  assert.match(html, /<pre>\*\*literal\*\* &lt;tag&gt;<\/pre>/);
});

test('start planning shows progress before its request resolves and prevents duplicate submissions', async () => {
  const { app, context, listeners } = dashboard();
  let rejectRequest!: (error: Error) => void;
  const waiting = new Promise<Response>((_, reject) => { rejectRequest = reject; });
  let posts = 0, submitted: any;
  context.FormData = class extends Map<string, string> {
    constructor(form: { values: Record<string, string> }) { super(); for (const [key, value] of Object.entries(form.values)) this.set(key, value); }
  };
  context.fetch = async (path: string, options: { method: string; body: string }) => {
    if (path === '/api/kickoffs') { posts++; submitted = JSON.parse(options.body); return waiting; }
    return new Response(JSON.stringify({ tasks: [], kickoffs: [], jobs: {}, journal: '' }));
  };
  runInContext("screen = 'new';", context);
  const event = { preventDefault() {}, target: { id: 'kickoff-form', dataset: {}, values: { repo: 'C:/repo', request: 'Preserve this request', referenceFolders: '' } } };
  const sending = listeners.get('submit')!(event);
  assert.match(app.innerHTML, /Preparing repository context/);
  assert.match(app.innerHTML, /disabled>Inspecting repository…/);
  assert.equal(submitted.request, 'Preserve this request');
  await listeners.get('submit')!(event);
  assert.equal(posts, 1);
  rejectRequest(new Error('Offline repository inspection failed'));
  await sending;
  assert.doesNotMatch(app.innerHTML, /Preparing repository context/);
  assert.match(app.innerHTML, />Start planning<\/button>/);
});

test('planner progress renders real activity safely and elapsed time without percentages', () => {
  const { context } = dashboard();
  context.item = { session: { phase: 'running' }, progress: {
    stage: 'responding', activity: 'Writing the planner response', repositoryCalls: 2, integrationCalls: 1,
    startedAt: new Date(Date.now() - 62000).toISOString(), lastActivityAt: new Date().toISOString(),
    recent: [{ label: 'Read src/<export>.ts' }, { label: 'Requested linear · get_issue' }],
  } };
  const html = runInContext('plannerProgressCard(item)', context) as string;
  assert.match(html, /Writing a response/);
  assert.match(html, /2 repository actions · 1 MCP request/);
  assert.match(html, /Read src\/&lt;export&gt;\.ts/);
  assert.match(html, /1m 2s/);
  assert.doesNotMatch(html, /\d+%/);
  assert.equal(runInContext("elapsedTime('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:01:05Z'))", context), '1m 5s');
  assert.equal(runInContext("elapsedTime('2026-01-01T00:00:00Z', Date.parse('2025-12-31T23:59:59Z'))", context), '0s');
});
