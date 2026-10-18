import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Current-format plan and state fields that dashboard fixtures share.
const workflowPolicy = { mode: 'automatic', repairRounds: 2, maxSessionTurns: 6, maxContextTokens: 120000 };
const planContext = { files: [], exploration: true, inventoryDigest: 'fixture', totalFiles: 1, totalBytes: 1 };
const cycles = {
  repairCycle: { used: 0, failures: [] },
  reviewCycle: { repairs: 0, history: [], arbitrating: false, arbitrationUsed: false },
};

function dashboard() {
  const listeners = new Map<string, (event: unknown) => Promise<void>>();
  const app = {
    innerHTML: '',
    querySelectorAll: () => [],
    addEventListener: (type: string, listener: (event: unknown) => Promise<void>) => listeners.set(type, listener),
  };
  const context = createContext({
    Event,
    document: {
      querySelector: (selector: string) => (selector === '#app' ? app : { addEventListener() {} }),
      getElementById: () => null,
    },
    location: { hash: '' },
    sessionStorage: { getItem: () => null, setItem() {} },
  });
  context.window = context;
  for (const file of [
    'node_modules/markdown-it/dist/browser/markdown-it.umd.min.js',
    'src/ui/markdown.js',
    'src/ui/app.js',
  ]) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    // Load the production renderer and event handlers without starting polling.
    runInContext(source.split(/\r?\nrefresh\(true\)\.catch\(showError\);/)[0]!, context);
  }
  return {
    app,
    context,
    listeners,
    render: (text: string) => runInContext(`window.GrampusMarkdown.render(${JSON.stringify(text)})`, context) as string,
  };
}

test('MCP cards always show only connected names and tool counts in the compact list', () => {
  const { context } = dashboard();
  context.servers = [
    { name: 'Linear <project>', status: 'connected', tools: 82, auth: 'oAuth' },
    { name: 'Disabled connector', status: 'disabled' },
    { name: 'Failed connector', status: 'failed' },
    { name: 'Login required', status: 'needs-auth' },
    { name: 'Configured connector', status: 'configured' },
    { name: 'Unknown connector', status: 'unknown' },
  ];
  const html = runInContext('integrationCard(servers)', context) as string;
  assert.match(html, /card compact-integrations/);
  assert.match(html, /integration-list/);
  assert.match(html, /Linear &lt;project&gt;/);
  assert.match(html, /82 tools/);
  assert.doesNotMatch(
    html,
    /Disabled connector|Failed connector|Login required|Configured connector|Unknown connector|connected|oAuth|class="check"/,
  );
  assert.equal(runInContext('integrationCard(servers.slice(1))', context), '');
  assert.equal(runInContext('integrationCard()', context), '');
});

test('failed checks start collapsed and load bounded plain-text output on demand', () => {
  const { context } = dashboard();
  context.check = {
    id: 'check-a',
    spec: { name: 'PDF validation', file: 'node', args: [] },
    phase: 'failed',
    issue: '\x1b[31mAssertionError: MarkInfo\x1b[0m',
    result: { stderr: 'DO_NOT_RENDER_RAW_OUTPUT' },
  };
  const html = runInContext('checkCard(check)', context) as string;
  assert.match(html, /AssertionError: MarkInfo/);
  assert.match(html, /Read stderr/);
  assert.match(html, /Read stdout/);
  assert.doesNotMatch(html, /<details[^>]*open|DO_NOT_RENDER_RAW_OUTPUT|\x1b|\[31m/);
  runInContext(
    "selected='task-a';loadedCheck={taskId:selected,checkId:'check-a',stream:'stderr',offset:0,content:'safe page',nextOffset:16000,totalCharacters:40000}",
    context,
  );
  const loaded = runInContext('checkCard(check)', context) as string;
  assert.match(loaded, /class="check-log"/);
  assert.match(loaded, /Next page/);
  assert.match(loaded, /safe page/);
});

test('MCP connections are the last sidebar panel on both planning and task pages', () => {
  const { context } = dashboard();
  context.servers = [{ name: 'Linear', status: 'connected', tools: 82 }];
  context.plan = {
    brief: { title: 'A task', outcome: 'An outcome', plan: 'An approach', criteria: ['A criterion'] },
    workspace: { repo: 'C:/repo', base: 'abc', path: 'C:/work' },
    workflowPolicy,
    context: planContext,
    implementation: { provider: 'codex', model: null },
    review: { provider: 'claude', model: null },
    slices: [
      {
        scope: { files: [] },
        validation: { name: 'Check', file: 'node', args: [], timeoutMs: 1000 },
        acceptance: { name: 'Accept', file: 'node', args: [], timeoutMs: 1000, expectedStdout: 'ok' },
        mode: 'no_change',
        message: 'Verify',
      },
    ],
  };
  runInContext(
    `
    selected = 'planning';
    state.kickoffs = [{id:selected,config:{request:'A request',repo:'C:/repo',base:'abc',provider:'codex',adapter:'git',files:[],exploration:true},session:{phase:'idle'},messages:[],integrations:servers}];
    detail = {task:{id:'task',brief:plan.brief},state:{status:'complete',stage:'complete',sliceIndex:0,version:1,plan,repairCycle:{used:0,failures:[]},reviewCycle:{repairs:0,history:[],arbitrating:false,arbitrationUsed:false}},
      integrations:servers,findings:[],checks:[],deliveries:[],events:[]};
  `,
    context,
  );
  assert.equal(runInContext("kickoffPage().endsWith(integrationCard(servers) + '</aside></div>')", context), true);
  runInContext("selected = 'task'", context);
  assert.equal(runInContext("taskPage().endsWith(integrationCard(servers) + '</aside></div>')", context), true);
});

test('dashboard Markdown formats agent explanations, nested lists, tables and code', () => {
  const { render } = dashboard();
  const html = render(
    "## What's already in place\n\n- The registry uses `createEncoders`.\n  - **PDF** returns a `Uint8Array`.\n- Fonts use *embedFiles*.\n\n```js\nconst limit = 14_400;\n```\n\n| Format | Encoder |\n| --- | --- |\n| PDF | pdfkit |\n\n> Keep the existing scale.",
  );
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
    {
      id: 'named',
      title: 'Fix <login> & logout',
      config: { request: 'Please could you look into a very long description' },
      session: { phase: 'running' },
    },
    { id: 'unnamed', config: { request: 'Unnamed description' }, session: { phase: 'idle' } },
  ];
  const html = runInContext('state.kickoffs = items; nav()', context) as string;
  assert.match(html, /Fix &lt;login&gt; &amp; logout/);
  assert.match(html, /Unnamed description/);
  assert.doesNotMatch(html, /Please could you|<login>/);
});

test('plan revisions, repair budgets and structured acceptance remain reviewable and escaped', () => {
  const { context } = dashboard();
  context.view = {
    state: {
      status: 'blocked',
      plan: {
        brief: { title: '</textarea><script>bad</script>', outcome: 'New output', plan: 'Small change' },
        workflowPolicy,
        reviewPolicy: { repairRounds: 2, arbitrator: { provider: 'codex', model: 'fixture' } },
      },
    },
  };
  const html = runInContext(
    'revisionCard(view) + reviewPolicyCard(view.state.plan) + usageCard({usage: [{provider:"codex",inputTokens:240,incomplete:["inputTokens"],observedSessions:1,sessions:2}]})',
    context,
  ) as string;
  assert.match(html, /revision-form/);
  assert.match(html, /Repair rounds/);
  assert.match(html, /Fresh arbitration: codex/);
  assert.match(html, /Partial totals/);
  assert.match(html, /<dd>240<\/dd>/);
  assert.match(html, /&lt;\/textarea&gt;/);
  assert.doesNotMatch(html, /<script>/);
  runInContext('view.state.owner = {token:"owned"}', context);
  assert.equal(runInContext('revisionCard(view)', context), '');
});

test('usage cards separate metrics, format costs, distinguish missing measurements and refresh values', () => {
  const { context } = dashboard();
  context.view = {
    usage: [
      {
        provider: 'claude',
        inputTokens: 9341,
        outputTokens: 102290,
        cachedInputTokens: 8133513,
        estimatedCostUsd: 5.829425780000001,
        billedCostUsd: null,
        incomplete: ['inputTokens', 'outputTokens', 'cachedInputTokens', 'estimatedCostUsd'],
        sessions: 3,
        observedSessions: 2,
        activeSessions: 1,
        updatedAt: '2026-10-18T18:04:00.000Z',
      },
    ],
  };
  const html = runInContext('usageCard(view)', context) as string;
  assert.match(html, /<dl class="usage-metrics">/);
  assert.match(html, /<dd>9,341<\/dd>/);
  assert.match(html, /<dd>8,133,513<\/dd>/);
  assert.match(html, /\$5\.8294/);
  assert.doesNotMatch(html, /5\.829425780000001/);
  assert.match(html, /2 of 3 sessions measured/);
  assert.match(html, /Live · partial/);
  assert.match(html, /Billed cost: unknown/);
  assert.match(html, /Last observation/);
  assert.match(html, /datetime="2026-10-18T18:04:00.000Z"/);
  runInContext('view.usage[0].inputTokens = 10000; view.usage[0].outputTokens = null;', context);
  const updated = runInContext('usageCard(view)', context) as string;
  assert.match(updated, /<dd>10,000<\/dd>/);
  assert.match(updated, /<dd>Unknown<\/dd>/);
  assert.doesNotMatch(updated, /<dd>9,341<\/dd>/);
});

test('agent Markdown escapes HTML, blocks executable links and avoids image requests', () => {
  const { render } = dashboard();
  const html = render(
    '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[run](javascript:alert%281%29) [encoded](jav&#x61;script:alert%281%29) [file](file:///C:/secret) [app](vscode:open)\n\n![remote image](https://example.com/track.png)\n\n[Spec](https://example.com/spec "Specification")',
  );
  assert.doesNotMatch(html, /<script|<img|href="(?:javascript|file|vscode):/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /remote image/);
  assert.match(
    html,
    /href="https:\/\/example.com\/spec" title="Specification" target="_blank" rel="noopener noreferrer"/,
  );
});

test('blocked file scopes explain why unchanged retry repeats the failure', () => {
  const { context } = dashboard();
  context.view = { state: { status: 'blocked', stage: 'scope' } };
  const html = runInContext('taskAction(view)', context) as string;
  assert.match(html, /revise this task’s plan/);
  assert.match(html, /same approved scope/);
});

test('question suggestions render inline Markdown and copy the exact editable answer without submitting', async () => {
  const { context, listeners } = dashboard();
  const choice = '**Same as JNow** (`pdfkit-latest` 2.0.15); install allowed';
  context.questions = [
    { id: 'deps', prompt: 'Which **dependencies**?', choices: [choice, '[spec](https://example.com)'] },
  ];
  const html = runInContext('questionsForm(questions, true)', context) as string;
  assert.match(html, /<strong>dependencies<\/strong>/);
  assert.match(html, /<li><button type="button" data-answer-target="answer-0"/);
  assert.match(html, /<strong>Same as JNow<\/strong>/);
  assert.match(html, /<code>pdfkit-latest<\/code>/);
  assert.doesNotMatch(html, /<a\b|<p>.*Same as JNow/);
  let focused = false;
  const field = {
    value: '',
    focus() {
      focused = true;
    },
    setSelectionRange() {},
    dispatchEvent() {},
  };
  const button = {
    disabled: false,
    dataset: { answerTarget: 'answer-0', answerValue: choice },
    textContent: 'Same as JNow (pdfkit-latest 2.0.15); install allowed',
    form: {
      querySelector: (selector: string) => {
        assert.equal(selector, '#answer-0');
        return field;
      },
    },
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
    brief: {
      title: 'PDF export',
      outcome: '**Export PDF**',
      criteria: ['Uses `Uint8Array`'],
      plan: '## Approach\n\n- Reuse the scale\n- Embed fonts',
    },
    workspace: { repo: 'C:/repo', base: 'abc', path: 'C:/work' },
    workflowPolicy,
    context: planContext,
    implementation: { provider: 'claude', model: null },
    review: { provider: 'codex', model: null },
    slices: [
      {
        scope: { files: ['src/export.ts'] },
        validation: { name: 'Tests', file: 'node', args: ['**literal** <tag>'], timeoutMs: 1000 },
        acceptance: { name: 'PDF', file: 'node', args: [], timeoutMs: 1000, expectedStdout: 'ok\n' },
        mode: 'commit',
        message: 'Add PDF',
      },
    ],
  };
  const html = runInContext('planCard(plan)', context) as string;
  assert.match(html, /<strong>Export PDF<\/strong>/);
  assert.match(html, /<code>Uint8Array<\/code>/);
  assert.match(html, /<h2>Approach<\/h2>/);
  assert.match(html, /<li>Reuse the scale<\/li>/);
  assert.match(html, /<pre>\*\*literal\*\* &lt;tag&gt;<\/pre>/);
});

test('preparation commands are visible for approval and failures offer a preparation retry', () => {
  const { context } = dashboard();
  context.plan = {
    brief: {
      title: 'Restore prerequisites',
      outcome: 'Run checks',
      criteria: ['Checks run'],
      plan: 'Restore then verify',
    },
    workspace: { repo: 'C:/repo', base: 'abc' },
    workflowPolicy,
    context: planContext,
    implementation: { provider: 'codex', model: null },
    review: { provider: 'claude', model: null },
    preparation: { name: 'Restore', file: 'node', args: ['<restore>'], timeoutMs: 600000 },
    slices: [
      {
        scope: { files: ['deps.lock'] },
        preparation: { name: 'Generate lockfile', file: 'node', args: ['<refresh>'], timeoutMs: 300000 },
        validation: { name: 'Check', file: 'node', args: [], timeoutMs: 1000 },
        acceptance: { name: 'Accept', file: 'node', args: [], timeoutMs: 1000 },
        mode: 'commit',
        message: 'Verify',
      },
    ],
  };
  const html = runInContext('planCard(plan)', context) as string;
  assert.match(html, /Preparation before implementation and checks/);
  assert.match(html, /&lt;restore&gt;/);
  assert.match(html, /Preparation after implementation/);
  assert.match(html, /&lt;refresh&gt;/);
  context.view = { state: { status: 'blocked', stage: 'refresh' } };
  const action = runInContext('taskAction(view)', context) as string;
  assert.match(action, /Retry preparation/);
  assert.match(action, /implementation attempt and retained files are preserved/);
});

test('start planning shows progress before its request resolves and prevents duplicate submissions', async () => {
  const { app, context, listeners } = dashboard();
  let rejectRequest!: (error: Error) => void;
  const waiting = new Promise<Response>((_, reject) => {
    rejectRequest = reject;
  });
  let posts = 0,
    submitted: any;
  context.FormData = class extends Map<string, string> {
    constructor(form: { values: Record<string, string> }) {
      super();
      for (const [key, value] of Object.entries(form.values)) this.set(key, value);
    }
  };
  context.fetch = async (path: string, options: { method: string; body: string }) => {
    if (path === '/api/kickoffs') {
      posts++;
      submitted = JSON.parse(options.body);
      return waiting;
    }
    return new Response(JSON.stringify({ tasks: [], kickoffs: [], jobs: {}, journal: '' }));
  };
  runInContext("screen = 'new';", context);
  const event = {
    preventDefault() {},
    target: {
      id: 'kickoff-form',
      dataset: {},
      values: { repo: 'C:/repo', request: 'Preserve this request', referenceFolders: '' },
    },
  };
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
  context.item = {
    session: { phase: 'running' },
    progress: {
      stage: 'responding',
      activity: 'Writing the planner response',
      repositoryCalls: 2,
      integrationCalls: 1,
      startedAt: new Date(Date.now() - 62000).toISOString(),
      lastActivityAt: new Date().toISOString(),
      recent: [{ label: 'Read src/<export>.ts' }, { label: 'Requested linear · get_issue' }],
    },
  };
  const html = runInContext('plannerProgressCard(item)', context) as string;
  assert.match(html, /Writing a response/);
  assert.match(html, /2 repository actions · 1 MCP request/);
  assert.match(html, /Read src\/&lt;export&gt;\.ts/);
  assert.match(html, /1m 2s/);
  assert.doesNotMatch(html, /\d+%/);
  assert.equal(
    runInContext("elapsedTime('2026-01-01T00:00:00Z', Date.parse('2026-01-01T00:01:05Z'))", context),
    '1m 5s',
  );
  assert.equal(runInContext("elapsedTime('2026-01-01T00:00:00Z', Date.parse('2025-12-31T23:59:59Z'))", context), '0s');
});

test('task work shows stage, current activity and elapsed time through quiet periods and stops', () => {
  const { context } = dashboard();
  context.view = {
    state: { status: 'running', stage: 'implementation', owner: { token: 'owned' }, ...cycles },
    events: [],
    progress: {
      activity: 'Reading src/<change>.ts',
      repositoryCalls: 3,
      integrationCalls: 1,
      fileRequests: 2,
      startedAt: new Date(Date.now() - 62000).toISOString(),
      lastActivityAt: new Date().toISOString(),
      recent: [{ label: 'Requested file changes: src/<change>.ts' }],
    },
  };
  runInContext("selected = 'task'; state.jobs.task = {running:true};", context);
  let html = runInContext('taskAction(view)', context) as string;
  assert.match(html, /Implementing the change/);
  assert.match(html, /Reading src\/&lt;change&gt;\.ts/);
  assert.match(html, /3 repository actions · 1 MCP request · 2 file change requests/);
  assert.match(html, /1m 2s/);
  assert.match(html, /Last activity/);
  assert.match(html, /data-action="stop"/);
  assert.doesNotMatch(html, /Working through the approved plan|\d+%/);
  runInContext(
    "view.progress = null; view.state.stage = 'verification'; view.checks = [{phase:'running',spec:{name:'PDF acceptance'}}];",
    context,
  );
  html = runInContext('taskAction(view)', context) as string;
  assert.match(html, /Checking acceptance criteria/);
  assert.match(html, /Running PDF acceptance/);
  runInContext('view.state.stopRequested = true', context);
  assert.match(runInContext('taskAction(view)', context) as string, /Stopping the task/);
});

test('timeline starts with the latest three entries and can expand beyond the polling window', async () => {
  const { context, listeners } = dashboard();
  const events = Array.from({ length: 55 }, (_, index) => ({
    sequence: index + 1,
    at: '2026-01-01T00:00:00Z',
    type: `event.${index}`,
    data: { note: `Note <${index}>` },
  }));
  context.view = { state: { version: 1, digest: 'fixture' }, events: events.slice(-30), eventCount: events.length };
  const list = { tasks: [{ id: 'task' }], kickoffs: [], jobs: {}, journal: '' };
  const requests: string[] = [];
  context.fetch = async (path: string) => {
    requests.push(path);
    return new Response(
      JSON.stringify(path.endsWith('/events') ? { events } : path === '/api/state' ? list : context.view),
    );
  };
  runInContext("selected = 'task'; screen = 'task'; taskPage = () => timelineCard(view);", context);
  let html = runInContext('timelineCard(view)', context) as string;
  assert.match(html, /View full timeline \(55\)/);
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.ok(html.indexOf('event · 54') < html.indexOf('event · 53'));
  const click = () =>
    listeners.get('click')!({
      target: { closest: () => ({ disabled: false, dataset: { action: 'toggle-timeline' } }) },
    });
  await click();
  html = runInContext('timelineCard(view)', context) as string;
  assert.equal((html.match(/<li>/g) || []).length, 55);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /Note &lt;0&gt;/);
  events.push({ sequence: 56, at: '2026-01-01T00:00:01Z', type: 'event.latest', data: { note: 'Latest' } });
  context.view = { state: { version: 1, digest: 'fixture' }, events: events.slice(-30), eventCount: events.length };
  await runInContext('refresh()', context);
  assert.match(runInContext('timelineCard(view)', context) as string, /event · latest/);
  assert.equal(requests.filter(path => path.endsWith('/events')).length, 2);
  await click();
  html = runInContext('timelineCard(view)', context) as string;
  assert.equal((html.match(/<li>/g) || []).length, 3);
  assert.match(html, /aria-expanded="false"/);
});
