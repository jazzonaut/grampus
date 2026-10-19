const app = document.querySelector('#app'),
  alertBox = document.querySelector('#error');
const fragment = location.hash.slice(1);
if (fragment) {
  sessionStorage.setItem('grampus-token', fragment);
  history.replaceState(null, '', location.pathname);
}
let token = sessionStorage.getItem('grampus-token') || '';
let state = { tasks: [], kickoffs: [], jobs: {}, journal: '' },
  selected = null,
  detail = null,
  screen = 'home',
  signature = '',
  pending = false;
let renderedKey = '';
let repositoryPreview = null,
  previewInput = '',
  fileSearch = null,
  loadedReport = null;
let refreshSerial = 0;
let folderSuggestions = [];
let planningRequest = null;
let timelineExpandedId = null,
  loadedTimeline = null;
let loadedCheck = null;
try {
  const saved = JSON.parse(sessionStorage.getItem('grampus-selection') || 'null');
  if (saved && ['task', 'kickoff'].includes(saved.screen)) {
    selected = saved.selected;
    screen = saved.screen;
  }
} catch {}
const esc = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const markdown = text => `<div class="markdown">${window.GrampusMarkdown.render(text)}</div>`;
const markdownInline = text => `<span class="markdown-inline">${window.GrampusMarkdown.inline(text)}</span>`;
const pretty = value => esc(JSON.stringify(value, null, 2));
const names = {
  draft: 'Plan ready for approval',
  ready: 'Ready to continue',
  running: 'Working',
  awaiting_scope: 'File approval needed',
  awaiting_assessment: 'Quality assessment needed',
  awaiting_answer: 'Your answer is needed',
  blocked: 'Needs attention',
  recovery_required: 'Recovery needed',
  complete: 'Delivered locally',
  idle: 'Plan ready',
  failed: 'Planning stopped',
  interrupted: 'Interrupted',
  stop_requested: 'Stopping',
};
const label = value => names[value] || value?.replaceAll('_', ' ') || '';
const plainText = text =>
  String(text || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
const humanNote = text =>
  plainText(text)
    .replace(/task-authorize/g, 'the file authorization button')
    .replace(/task-answer/g, 'the answer form')
    .replace(/task-assess/g, 'the quality assessment form')
    .replace(/task-rerun-checks/g, 'Rerun checks')
    .replace(/task-retry/g, 'a repair attempt')
    .replace(/task-recover/g, 'Recover saved work')
    .replace(/task-run/g, 'Continue task')
    .replace(/task-show/g, 'the task details');
const badge = value => `<span class="badge ${esc(value)}">${esc(label(value))}</span>`;
const button = (action, text, cls = '', attributes = '') =>
  `<button type="${attributes.includes('submit') ? 'submit' : 'button'}" data-action="${action}" class="${cls}" ${pending ? 'disabled' : ''} ${attributes}>${text}</button>`;
const code = text => `<pre>${esc(text)}</pre>`;
const notice = (text, error = false) => (text ? `<div class="notice${error ? ' error' : ''}">${esc(text)}</div>` : '');
const field = (id, title, type = 'text', value = '', extra = '') =>
  `<label for="${id}">${title}</label><input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${extra}>`;
function showError(error) {
  alertBox.textContent = error.message || String(error);
  alertBox.hidden = false;
}
alertBox.addEventListener('click', () => {
  alertBox.hidden = true;
});
async function api(path, payload) {
  const response = await fetch(path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function nav() {
  const items = state.tasks
    .map(
      task =>
        `<button class="navitem ${selected === task.id ? 'selected' : ''}" data-task="${esc(task.id)}"><span class="dot ${esc(task.status)}"></span>${esc(task.title)}<small>${esc(label(task.status))}</small>${stallBadge(task.stalled)}</button>`,
    )
    .join('');
  const kickoffs = state.kickoffs
    .filter(item => !item.taskId)
    .map(
      item =>
        `<button class="navitem ${selected === item.id ? 'selected' : ''}" data-kickoff="${esc(item.id)}">${esc(item.title || item.config.request.slice(0, 70))}<small>${esc(label(item.session.phase))}</small></button>`,
    )
    .join('');
  const info = state.application;
  return `<aside class="sidebar"><div class="brand"><img class="mark" src="/favicon.svg" width="31" height="31" alt="">grampus</div><button class="new" data-action="new">＋ New task</button><div class="eyebrow">Tasks</div>${items || '<p class="empty">Your tasks will appear here.</p>'}${kickoffs ? `<div class="eyebrow">Planning</div>${kickoffs}` : ''}<footer>WINDOWS ALPHA${info ? `<br>v${esc(info.version)} · ${esc(info.channel)}${info.build ? `<br><span title="${esc(info.build.builtAt)}">Build ${esc(info.build.id)}</span>` : ''}` : ''}<br>Local work. Independent review.<br>Your journal survives restarts.</footer></aside>`;
}
const healthNames = {
  healthy: 'Healthy',
  failed: 'Failed',
  untested: 'Not tested',
  not_configured: 'Not configured',
  auth_unavailable: 'Sign-in needed',
  temporarily_unavailable: 'Temporarily unavailable',
};
const minutesSince = since => Math.max(0, Math.floor((Date.now() - Date.parse(since)) / 60000)) || 0;
// Silence is only surfaced; the user decides whether to stop the task.
const stallBadge = stalled =>
  stalled
    ? `<span class="badge stalled" title="Last activity ${esc(stalled.lastActivityAt)}">No activity for ${minutesSince(stalled.lastActivityAt)} min</span>`
    : '';
function stallNotice(stalled) {
  if (!stalled) return '';
  const name = stalled.owner.label.charAt(0).toUpperCase() + stalled.owner.label.slice(1);
  const owner = stalled.owner.kind === 'check' ? `check ${stalled.owner.label}` : `${name} session`;
  return notice(
    `No activity from the ${owner} for ${minutesSince(stalled.lastActivityAt)} min. Nothing has been stopped: wait if this step is slow, or choose Request stop if it is hung.`,
  );
}
function healthIndicator(health = state.health) {
  if (!health) return '';
  const title =
    health.status === 'unknown'
      ? 'Integrations not checked yet'
      : health.status === 'healthy'
        ? 'Integrations healthy'
        : 'Integrations need attention';
  const capability = item =>
    `<li title="${esc(item.detail)}">${esc(item.name)}: ${esc(healthNames[item.status] || item.status)}${['healthy', 'untested'].includes(item.status) ? '' : ` · ${esc(item.detail)}`}</li>`;
  const rows = health.integrations
    .map(
      item =>
        `<li><b>${esc(item.id)}</b> <span class="health-status ${esc(item.status)}">${esc(healthNames[item.status] || item.status)}</span>${item.version ? ` <code>${esc(item.version)}</code>` : ''}<ul>${item.capabilities.map(capability).join('')}</ul></li>`,
    )
    .join('');
  return `<details class="health ${esc(health.status)}"><summary>${esc(title)}</summary><div class="health-details">${health.warnings.map(warning => notice(warning)).join('')}${health.checkedAt ? `<p class="hint">Checked ${esc(elapsedTime(health.checkedAt))} ago${health.stale ? ' · due for a new check' : ''}</p>` : ''}${rows ? `<ul class="health-list">${rows}</ul>` : ''}${button('health-refresh', 'Check again')}</div></details>`;
}
function welcome() {
  return `<div class="welcome"><div class="eyebrow">Your local coding workspace</div><h1>A clear brief.<br>A checked, reviewed change.</h1><p class="lead muted">Describe what you want to change. Grampus helps clarify the details, prepares a plan, and guides the work through to a local commit.</p><div class="actions">${button('new', 'Start a task →', 'primary')}</div><div class="intro-grid"><section class="card"><span class="eyebrow">01 / Plan</span><b>Agree on the outcome</b><p>Discuss the task and review the files, checks and examples before approving.</p></section><section class="card"><span class="eyebrow">02 / Work</span><b>Keep the evidence</b><p>Follow implementation, quality passes, independent review and acceptance in one place.</p></section><section class="card"><span class="eyebrow">03 / Deliver</span><b>Stay in control</b><p>Answer questions, request a stop or recover interrupted work. Delivery stays local.</p></section></div></div>`;
}
function managementCard(active, converted = false) {
  if (converted) return '';
  return `<section class="card"><h2>Manage task</h2><p class="hint">Reset restarts planning from the original request. Existing workspace files, commits and recorded history are kept.</p><div class="actions">${button('reset', 'Reset task', '', active ? 'disabled' : '')}${button('delete', 'Delete task', 'danger', active ? 'disabled' : '')}</div>${active ? '<p class="hint">Stop the task and confirm settlement or recovery before resetting or deleting it.</p>' : ''}</section>`;
}
function integrationCard(servers = []) {
  servers = servers.filter(server => server.status === 'connected');
  return servers.length
    ? `<section class="card compact-integrations"><h2>MCP connections</h2><ul class="integration-list">${servers.map(server => `<li><b>${esc(server.name)}</b>${server.tools !== undefined ? `<span>${esc(server.tools)} tools</span>` : ''}</li>`).join('')}</ul></section>`
    : '';
}
function referenceFields(references = [], suggestions = [], planner = false) {
  return `<h3>Reference folders</h3><p class="hint">Agents can search and read these folders throughout the task. File changes remain confined to the approved task workspace.</p><label for="${planner ? 'planner-references' : 'reference-folders'}">Absolute folder paths, one per line</label><textarea id="${planner ? 'planner-references' : 'reference-folders'}" name="referenceFolders" rows="3" placeholder="C:/ReferenceProject">${esc(references.map(item => item.path).join('\n'))}</textarea>${!planner ? `<div class="actions">${button('suggest-references', 'Suggest from task description')}</div><p class="hint">Folders explicitly mentioned in the description are also detected when planning starts.</p>` : ''}${suggestions.length ? `<div class="file-results">${suggestions.map(item => `<button type="button" data-reference-path="${esc(item.path)}">Add ${esc(item.path)}<small>${esc(item.reason)}</small></button>`).join('')}</div>` : ''}`;
}
function referenceCard(item, editable) {
  const references = item.config?.references || item.state?.plan.references || [];
  const suggestions = item.referenceSuggestions || [];
  if (!editable)
    return references.length
      ? `<section class="card"><h2>Read-only references</h2>${references.map((reference, index) => `<p><b>reference-${index + 1}</b></p>${code(reference.path)}<p class="hint">${reference.totalFiles.toLocaleString()} files · ${esc(reference.base?.slice(0, 12) || 'Captured folder inventory')}</p>`).join('')}</section>`
      : '';
  return `<section class="card"><form id="reference-form">${referenceFields(references, suggestions, true)}<div class="actions"><button type="submit">Update reference folders</button></div><p class="hint">Updating references invalidates the proposed plan. Send a message to continue planning.</p></form></section>`;
}
function newTask() {
  return `<div class="eyebrow">Task kickoff</div><h1>What would you like to change?</h1><p class="muted lead">Start with the outcome. The planner reads the committed repository and asks about details that could change the result.</p><div class="columns"><section class="card focus"><h2>Describe the task</h2>${planningRequest?.id === null ? plannerProgressCard(null) : ''}<form id="kickoff-form">${field('repo', 'Repository folder', 'text', '', 'required placeholder="C:\\Projects\\my-project"')}<p class="hint">An existing Git repository with a committed baseline. Agents find and read the relevant code themselves. You approve the exact files they may change before implementation.</p><label for="request">What should be different when this is done?</label><textarea id="request" name="request" rows="6" required placeholder="Describe the behavior, include a few examples, and say what should stay the same."></textarea>${referenceFields([], folderSuggestions)}<div class="row"><div><label for="provider">Planner and implementer</label><select id="provider" name="provider"><option value="codex">Codex</option><option value="claude">Claude</option></select></div><div><label for="adapter">Workspace</label><select id="adapter" name="adapter"><option value="git">Standalone Git worktree</option><option value="orca">Local Orca worktree</option></select></div></div><p class="hint">Agents run until they finish or you choose Stop. There is no automatic time limit.</p><details><summary>Optional file hints</summary><p class="hint">Point the planner at useful files, or leave discovery to the agent.</p>${repositoryPreview ? contextFields(repositoryPreview.context, false) : ''}<div class="actions">${button('inspect', repositoryPreview ? 'Refresh suggestions' : 'Suggest starting files')}</div></details><div class="actions"><button class="primary" type="submit" ${pending ? 'disabled' : ''}>${planningRequest?.id === null ? 'Inspecting repository…' : 'Start planning'}</button></div></form>${repositoryPreview ? searchCard() : ''}</section><aside><section class="card"><h2>Before work begins</h2><p class="muted">Planning uses your existing subscription login. You’ll review the complete plan and authorize the exact files before implementation starts.</p><p class="hint">The other provider reviews the result. Routine check failures are repaired within the approved allowance. Commits stay local.</p></section><section class="card"><details><summary>Already have a guided plan?</summary><form id="import-form"><label for="plan-json">Import plan JSON</label><textarea id="plan-json" name="plan" rows="9" required></textarea><div class="actions"><button type="submit">Import for approval</button></div></form></details></section></aside></div>`;
}
function contextFields(context, planner) {
  const paths = context?.selected || [];
  return `<h3>Starting file hints</h3><p class="hint">${context.totalFiles.toLocaleString()} files in the pinned commit; ${paths.length} supplied initially. Agents can search and read the remaining files as needed.</p><p class="hint">File hints are optional and do not grant edit permission. Agents investigate callers, tests and configuration themselves. Review also receives all changed files and repository instructions.</p><label for="${planner ? 'planner-context-files' : 'context-files'}">Optional starting paths, one per line</label><textarea id="${planner ? 'planner-context-files' : 'context-files'}" name="contextFiles" rows="8">${esc(paths.join('\n'))}</textarea><details><summary>Repository map</summary>${code(context.directories.map(item => `${item.path}: ${item.files} files`).join('\n'))}<p class="hint">Files outside the starting list remain available through repository exploration. Search the inventory below to add hints. Inventory digest: ${esc(context.inventoryDigest)}</p></details>`;
}
function searchCard() {
  return `<section class="context-search"><h3>Search the pinned file inventory</h3><form id="context-search-form"><label for="context-query">Path contains</label><input id="context-query" name="query" placeholder="e.g. src greeting"><div class="actions"><button type="submit">Search files</button></div></form>${fileSearch ? `<p class="hint">${fileSearch.matches.toLocaleString()} matches; showing ${fileSearch.offset + (fileSearch.files.length ? 1 : 0)} to ${fileSearch.offset + fileSearch.files.length}</p><div class="file-results">${fileSearch.files.map(file => `<button type="button" data-context-path="${esc(file.path)}">Add ${esc(file.path)} <small>${file.bytes.toLocaleString()} bytes</small></button>`).join('')}</div><div class="actions">${fileSearch.offset ? button('search-prev', 'Previous 100') : ''}${fileSearch.nextOffset !== null ? button('search-next', 'Next 100') : ''}</div>` : ''}</section>`;
}
const parsePaths = value =>
  String(value || '')
    .split(/\r?\n/)
    .map(path => path.trim())
    .filter(Boolean);
async function searchFiles(offset = 0) {
  const config = screen === 'kickoff' ? state.kickoffs.find(item => item.id === selected)?.config : repositoryPreview;
  if (!config) throw new Error('Inspect a repository first');
  const query = document.querySelector('#context-query')?.value || '';
  fileSearch = await api('/api/repositories/files', { repo: config.repo, base: config.base, query, offset });
  render();
}
function explorationCard(summary) {
  if (!summary?.calls) return '';
  return `<section class="card"><h2>Repository exploration</h2><p class="hint">${summary.calls} search, list and read calls completed.</p>${summary.readFiles.length ? `<h3>Recently read files</h3>${code(summary.readFiles.join('\n'))}` : ''}<p class="hint">Read access is independent of approved file changes. Reading files does not establish test coverage.</p></section>`;
}
function planCard(plan) {
  return `<section class="card"><h2>The proposed plan</h2>${markdown(plan.brief.outcome)}<h3>Repository access</h3><p class="hint">${plan.context.exploration ? 'Agents can search and read repository files as needed. ' : 'This plan uses selected context only. '}${plan.context.files.length} initial files out of ${plan.context.totalFiles.toLocaleString()}. Changes require the exact file permissions below. Review includes all changed files and instructions.</p>${code(plan.context.files.join('\n'))}<h3>Acceptance criteria</h3><ul>${plan.brief.criteria.map(item => `<li>${markdown(item)}</li>`).join('')}</ul><h3>Approach</h3>${markdown(plan.brief.plan)}<dl class="facts"><dt>Repository</dt><dd>${esc(plan.workspace.repo)}</dd><dt>Base commit</dt><dd><code>${esc(plan.workspace.base)}</code></dd><dt>Workspace</dt><dd>${esc(plan.workspace.path || 'Created through Orca')}</dd><dt>Agents</dt><dd>${esc(plan.implementation.provider)} implements · ${esc(plan.review.provider)} reviews<br>Models: ${esc(plan.implementation.model || 'provider default')} / ${esc(plan.review.model || 'provider default')}<br>No automatic agent time limit</dd></dl>${workflowPolicyCard(plan)}${reviewPolicyCard(plan)}${qualityCard(plan)}${plan.preparation ? `<h3>Preparation before implementation and checks</h3><p class="hint">Runs in the task worktree and must leave repository inputs unchanged.</p>${commandCard(plan.preparation)}<p class="hint">Timeout: ${plan.preparation.timeoutMs / 1000}s</p>` : ''}${plan.revision ? `<p class="hint">Retained workspace checkpoint: ${esc(plan.revision.artifact)}. Earlier checks and reviews need to run again.</p>` : ''}${plan.slices.map((slice, index) => `<h3>Slice ${index + 1} · ${esc(plan.brief.slices?.[index]?.title || plan.brief.title)}</h3>${plan.brief.slices?.[index] ? `${markdown(plan.brief.slices[index].plan)}<ul>${plan.brief.slices[index].criteria.map(item => `<li>${markdown(item)}</li>`).join('')}</ul>` : ''}<div class="hint">Files to edit</div>${code(slice.scope.files.join('\n') || '(none)')}${slice.scope.create?.length ? `<div class="hint">Files to create</div>${code(slice.scope.create.join('\n'))}` : ''}${slice.scope.delete?.length ? `<div class="hint">Files to delete</div>${code(slice.scope.delete.join('\n'))}` : ''}${slice.preparation ? `<div class="hint">Preparation after implementation · ${esc(slice.preparation.name)} · ${slice.preparation.timeoutMs / 1000}s</div><p class="hint">May update only this slice’s authorized files before validation.</p>${commandCard(slice.preparation)}` : ''}<div class="hint">Validation · ${esc(slice.validation.name)} · ${slice.validation.timeoutMs / 1000}s</div>${commandCard(slice.validation)}<div class="hint">Acceptance · ${esc(slice.acceptance.name)} · ${slice.acceptance.timeoutMs / 1000}s</div>${commandCard(slice.acceptance)}${slice.acceptance.expectedStdout !== undefined ? `<div class="hint">Exact expected stdout (JSON escaped)</div>${code(JSON.stringify(slice.acceptance.expectedStdout))}` : ''}${slice.acceptance.expectations ? `<div class="hint">Additional acceptance observations</div>${code(JSON.stringify(slice.acceptance.expectations, null, 2))}` : ''}<p class="hint">Delivery: ${esc(slice.mode)} · ${esc(slice.message)}</p>`).join('')}</section>`;
}
function commandCard(command) {
  return `<details class="command-details"><summary>Exact command</summary><div class="hint">Executable</div>${code(command.file)}${command.args.map((arg, index) => `<div class="hint">Argument ${index + 1}</div>${code(arg)}`).join('')}<details><summary>Exact argument array</summary>${code(JSON.stringify(command.args))}</details></details>`;
}
function checkCard(check) {
  const page = loadedCheck?.taskId === selected && loadedCheck.checkId === check.id ? loadedCheck : null;
  return `<details class="check-details" ${page ? 'open' : ''}><summary>${esc(check.spec.name)} · ${esc(check.phase)}</summary>${check.issue ? `<pre class="check-issue">${esc(plainText(check.issue))}</pre>` : ''}${check.error ? notice(plainText(check.error), true) : ''}${commandCard(check.spec)}<div class="actions">${button('check-output', 'Read stderr', '', `data-check-id="${esc(check.id)}" data-stream="stderr"`)}${button('check-output', 'Read stdout', '', `data-check-id="${esc(check.id)}" data-stream="stdout"`)}</div>${page ? `<p class="hint">${esc(page.stream)} · ${page.offset.toLocaleString()}–${(page.offset + page.content.length).toLocaleString()} of ${page.totalCharacters.toLocaleString()} characters</p><pre class="check-log" tabindex="0" aria-label="Check output">${esc(page.content || '(empty)')}</pre><div class="actions">${page.offset ? button('check-output', 'First page', '', `data-check-id="${esc(check.id)}" data-stream="${page.stream}"`) : ''}${page.nextOffset !== null ? button('check-output', 'Next page', '', `data-check-id="${esc(check.id)}" data-stream="${page.stream}" data-offset="${page.nextOffset}"`) : ''}</div>` : ''}</details>`;
}
function workflowPolicyCard(plan) {
  const policy = plan.workflowPolicy;
  return `<p class="hint">${policy.mode === 'automatic' ? `Automatic workflow: implement, validate, repair, independently review and deliver within the approved scope. Up to ${policy.repairRounds} check repairs per slice.` : 'Supervised workflow: pause for file authorization and quality assessment.'} Resume conversations within a slice; start fresh after ${policy.maxSessionTurns} turns or ${policy.maxContextTokens.toLocaleString()} observed context tokens. Each slice and arbitration starts fresh.</p>`;
}
function questionsForm(questions, kickoff = false) {
  return `<form id="${kickoff ? 'planner-answer-form' : 'answer-form'}">${questions.map((question, index) => `<label for="answer-${index}">${markdownInline(question.prompt)}</label>${question.choices.length ? `<p class="hint" id="answer-hint-${index}">Choose a suggestion to fill your answer, then edit if needed.</p><ul class="answer-suggestions" aria-label="Suggested answers">${question.choices.map(choice => `<li><button type="button" data-answer-target="answer-${index}" data-answer-value="${esc(choice)}" aria-controls="answer-${index}">${markdownInline(choice)}</button></li>`).join('')}</ul>` : ''}<textarea id="answer-${index}" name="${esc(question.id)}" rows="2" ${question.choices.length ? `aria-describedby="answer-hint-${index}"` : ''} required></textarea>`).join('')}<div class="actions"><button class="primary" type="submit">Send answers and continue →</button></div></form>`;
}
function elapsedTime(since, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) || 0;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function plannerProgressCard(item) {
  const progress = item?.progress;
  const initial = !item;
  const stopping = item?.session.phase === 'stop_requested';
  const titles = {
    connecting: 'Connecting to the agent',
    working: 'Agent is working',
    responding: 'Writing a response',
    finishing: 'Finishing the response',
    stopping: 'Stopping planning',
  };
  const title = stopping
    ? titles.stopping
    : initial
      ? 'Preparing repository context'
      : titles[progress?.stage] || 'Starting the planner';
  const activity = stopping
    ? 'Waiting for the agent to stop safely'
    : progress?.activity ||
      (initial ? 'Inspecting the repository and pinning the files for planning.' : 'Starting the planning session.');
  const startedAt = progress?.startedAt || planningRequest?.startedAt;
  const counts = progress
    ? `${progress.repositoryCalls} repository ${progress.repositoryCalls === 1 ? 'action' : 'actions'} · ${progress.integrationCalls} MCP ${progress.integrationCalls === 1 ? 'request' : 'requests'}`
    : '';
  return `<section class="planner-progress" aria-label="Planning progress"><div class="planner-progress-heading"><span class="spinner" aria-hidden="true"></span><strong role="status">${esc(title)}</strong>${startedAt ? `<span class="elapsed" title="Elapsed time" data-elapsed-since="${esc(startedAt)}">${elapsedTime(startedAt)}</span>` : ''}</div><p>${esc(activity)}</p>${counts ? `<p class="hint">${esc(counts)}</p>` : ''}${progress?.recent.length ? `<ul class="planner-activity">${progress.recent.map(event => `<li>${esc(event.label)}</li>`).join('')}</ul>` : ''}${progress?.lastActivityAt ? `<p class="hint">Last activity <span data-elapsed-since="${esc(progress.lastActivityAt)}">${elapsedTime(progress.lastActivityAt)}</span> ago</p>` : ''}<p class="hint">${initial ? 'Planning starts after the repository is ready.' : 'You can leave this page; progress is saved locally.'}</p></section>`;
}
function updateProgressTimes() {
  for (const el of app.querySelectorAll('[data-elapsed-since]')) el.textContent = elapsedTime(el.dataset.elapsedSince);
}
function taskProgressCard(view) {
  const s = view.state,
    progress = view.progress,
    job = state.jobs[selected];
  const stages = {
    workspace: ['Preparing the workspace', 'Creating the worktree and checking its repository baseline.'],
    execution: ['Preparing implementation', 'Capturing repository context for the implementer.'],
    preparation: ['Preparing the workspace', 'Running the approved preparation command before implementation.'],
    refresh: ['Preparing checks', 'Refreshing prerequisites within the approved plan before validation.'],
    scope: ['Inspecting file scope', 'Checking repository instructions and the files that need authorization.'],
    implementation: [
      s.failedCheckId && s.repairCycle.used
        ? 'Repairing the check failure'
        : s.reviewCycle.repairs
          ? 'Addressing review findings'
          : 'Implementing the change',
      'The implementer is working within the approved file scope.',
    ],
    validation: ['Running validation', 'Running the approved validation command and collecting its result.'],
    submission: ['Collecting change evidence', 'Checking the changed files and retaining the implementation result.'],
    quality_pass: [
      'Running a quality pass',
      'The implementer is applying an approved quality pass within the approved file scope.',
    ],
    assessment: ['Recording quality assessments', 'Saving the assessment of each selected quality lens.'],
    review_execution: ['Preparing independent review', 'Capturing the change and its evidence for the reviewer.'],
    review: [
      s.reviewCycle.arbitrating ? 'Arbitrating review findings' : 'Reviewing the change',
      'The reviewer is inspecting the change and its supporting evidence.',
    ],
    verification: ['Checking acceptance criteria', 'Running the approved acceptance command and collecting evidence.'],
    delivery: ['Delivering locally', 'Verifying the final artifact and preparing local delivery.'],
    complete: ['Finishing the task', 'Saving the final task result.'],
  };
  const [stageTitle, stageActivity] = stages[s.stage] || ['Working on the task', 'Preparing the next approved step.'];
  const stopping = s.stopRequested || view.session?.phase === 'stop_requested';
  const currentEvents = (view.events || []).filter(event => !job?.startedAt || event.at >= job.startedAt);
  const step = [...currentEvents].reverse().find(event => event.type === 'guided.step_requested');
  const startedAt = progress?.startedAt || step?.at || job?.startedAt;
  const lastActivityAt = progress?.lastActivityAt || currentEvents.at(-1)?.at || startedAt;
  const check = view.checks?.find(check => check.phase === 'running');
  const activity = stopping
    ? 'Waiting for the current operation to stop safely.'
    : progress?.activity || (check ? `Running ${check.spec.name}` : stageActivity);
  const counts = progress
    ? `${progress.repositoryCalls} repository ${progress.repositoryCalls === 1 ? 'action' : 'actions'} · ${progress.integrationCalls} MCP ${progress.integrationCalls === 1 ? 'request' : 'requests'} · ${progress.fileRequests || 0} file change ${progress.fileRequests === 1 ? 'request' : 'requests'}`
    : '';
  return `<section class="planner-progress" aria-label="Execution progress"><div class="planner-progress-heading"><span class="spinner" aria-hidden="true"></span><strong role="status">${esc(stopping ? 'Stopping the task' : stageTitle)}</strong>${startedAt ? `<span class="elapsed" title="Elapsed time for this step" data-elapsed-since="${esc(startedAt)}">${elapsedTime(startedAt)}</span>` : ''}</div><p>${esc(activity)}</p>${counts ? `<p class="hint">${esc(counts)}</p>` : ''}${progress?.recent.length ? `<ul class="planner-activity">${progress.recent.map(event => `<li>${esc(event.label)}</li>`).join('')}</ul>` : ''}${lastActivityAt ? `<p class="hint">Last activity <span data-elapsed-since="${esc(lastActivityAt)}">${elapsedTime(lastActivityAt)}</span> ago</p>` : ''}<p class="hint">You can leave this page; progress is saved locally.</p></section>`;
}
function timelineEntries(events, full = false) {
  return [...events]
    .reverse()
    .map(
      event =>
        `<li><time datetime="${esc(event.at)}" title="${esc(new Date(event.at).toLocaleString())}">${esc(full ? new Date(event.at).toLocaleString() : new Date(event.at).toLocaleTimeString())}</time><div><span>${esc(event.type.replaceAll('.', ' · ').replaceAll('_', ' '))}</span>${event.data?.note ? `<div class="muted timeline-note">${esc(humanNote(event.data.note))}</div>` : ''}</div></li>`,
    )
    .join('');
}
function timelineCard(view) {
  const expanded = timelineExpandedId === selected,
    events = expanded && loadedTimeline?.id === selected ? loadedTimeline.events : (view.events || []).slice(-3);
  const count = view.eventCount ?? view.events?.length ?? 0;
  const live = state.jobs[selected]?.running && view.progress?.activity;
  return `<section class="card task-timeline" aria-label="Task timeline"><div class="timeline-heading"><h2>Task timeline</h2>${live ? `<span class="timeline-live" title="${esc(live)}"><span class="spinner" aria-hidden="true"></span><span role="status">${esc(live)}</span></span>` : ''}${count ? button('toggle-timeline', expanded ? 'Show recent activity' : `View full timeline (${count})`, '', `aria-expanded="${expanded}" aria-controls="task-timeline-history"`) : ''}</div>${events.length ? `<ol class="timeline ${expanded ? 'timeline-full' : 'timeline-recent'}" id="task-timeline-history">${timelineEntries(events, expanded)}</ol>` : '<p class="hint">Task activity will appear here.</p>'}</section>`;
}
function kickoffPage() {
  const item = state.kickoffs.find(item => item.id === selected);
  if (!item) return welcome();
  const job = state.jobs[item.id],
    active =
      planningRequest?.id === item.id || job?.running || ['running', 'stop_requested'].includes(item.session.phase);
  const uncertain = item.session.run || item.session.phase === 'recovery_required';
  return `<div class="eyebrow">Planning conversation</div><h1>Shape the task before starting.</h1>${badge(active ? 'running' : item.session.phase)}<div class="columns"><div><section class="card focus"><h2>Discussion</h2>${
    item.messages
      .map(message => {
        let text = message.text;
        if (message.role === 'user') {
          try {
            const answers = JSON.parse(text);
            if (
              answers &&
              !Array.isArray(answers) &&
              typeof answers === 'object' &&
              Object.values(answers).every(value => typeof value === 'string')
            )
              text = Object.values(answers).join('\n');
          } catch {}
        }
        if (message.role === 'assistant') {
          try {
            const raw = JSON.parse(text);
            if (raw.brief)
              text = `I’ve prepared a plan for “${item.title || raw.brief.title}”. Review its scope and checks below, or ask for changes.`;
          } catch {}
        }
        return `<div class="message"><span class="eyebrow">${message.role === 'user' ? 'You' : esc(item.config.provider)}</span>${markdown(text)}</div>`;
      })
      .join('') || `<p>${esc(item.config.request)}</p>`
  }${notice(item.error, true)}${notice(job?.error, true)}${active ? plannerProgressCard(item) + (item.session.run ? `<div class="actions">${button('stop', item.session.phase === 'stop_requested' ? 'Stop requested…' : 'Stop planning', 'danger')}</div>` : '') : ''}${item.taskId ? `<div class="actions">${button('open-task', 'Open task →', 'primary')}</div>` : !active && uncertain ? `${notice('The earlier planner still owns its session. Recovery must prove that its processes exited.')}<div class="actions">${button('planner-recover', 'Recover planning session')}</div>` : !active ? (item.session.phase === 'awaiting_answer' ? questionsForm(item.session.lastReply.questions, true) : `<form id="planner-message-form"><label for="revision">${item.messages.length ? 'Refine the plan' : 'Start planning'}</label><textarea id="revision" name="message" rows="3" ${item.messages.length ? 'required' : ''} placeholder="Ask for changes or add an example…"></textarea><div class="actions"><button type="submit">${item.messages.length ? 'Send message' : 'Prepare a plan'}</button>${item.candidate && !item.error && item.session.phase === 'idle' ? button('prepare', 'Review for approval →', 'primary') : ''}</div></form>`) : ''}</section>${item.candidate ? planCard(item.candidate) : ''}</div><aside>${managementCard(active || !!uncertain, !!item.taskId)}${referenceCard(item, !active && !uncertain && !item.taskId)}${explorationCard(item.exploration)}<section class="card"><h2>Repository access</h2><p class="hint">${item.config.exploration ? 'The planner can search and read the pinned repository itself. Starting file hints are optional.' : 'This saved conversation uses selected context. Start a new task for autonomous exploration.'}</p><dl class="facts"><dt>Repository</dt><dd>${esc(item.config.repo)}</dd><dt>Base</dt><dd><code>${esc(item.config.base)}</code></dd><dt>Provider</dt><dd>${esc(item.config.provider)}</dd><dt>Workspace</dt><dd>${esc(item.config.adapter)}</dd></dl><details><summary>${item.config.exploration ? 'Optional starting file hints' : 'Selected context (saved conversation)'}</summary><h3>Files supplied initially</h3>${code(item.config.files.join('\n'))}${!active && !uncertain && !item.taskId && item.config.context ? `<form id="planner-context-form">${contextFields(item.config.context, true)}<div class="actions"><button type="submit">Update file hints</button></div><p class="hint">Updating invalidates the previous proposal and starts no inference. Send a message or answer current questions to plan with the new hints.</p></form>${searchCard()}` : ''}</details><p class="hint">This is a draft conversation. Preparing a task does not approve it or start implementation.</p></section>${integrationCard(item.integrations)}</aside></div>`;
}
function expected(view) {
  const s = view.state;
  return JSON.stringify({
    version: s.version,
    digest: s.digest,
    status: s.status,
    stage: s.stage,
    artifact: s.snapshot?.artifact ?? null,
    instructionsDigest: s.snapshot?.instructionsDigest ?? null,
    executionId: s.executionId,
    reviewId: s.reviewId,
    failedCheckId: s.failedCheckId ?? null,
    questionKey: view.questionKey ?? null,
  });
}
function revisionCard(view) {
  const s = view.state;
  if (view.stale || s.owner || s.pending || s.status === 'recovery_required' || state.jobs[selected]?.running)
    return '';
  return `<section class="card"><details><summary>Revise this task’s plan</summary><p>Keep workspace files, commits and history. Delivered slices stay fixed. The revised plan needs fresh approval, file authorization, checks and review.</p><form id="revision-form"><label for="revision-title">Task name</label><input id="revision-title" name="title" value="${esc(s.plan.brief.title)}" required><label for="revision-outcome">Revised outcome</label><textarea id="revision-outcome" name="outcome" rows="4" required>${esc(s.plan.brief.outcome)}</textarea><label for="revision-approach">Approach</label><textarea id="revision-approach" name="approach" rows="3" required>${esc(s.plan.brief.plan)}</textarea><label for="workflow-mode">Workflow</label><select id="workflow-mode" name="workflowMode"><option value="automatic" ${s.plan.workflowPolicy.mode === 'automatic' ? 'selected' : ''}>Automatic within approved scope</option><option value="supervised" ${s.plan.workflowPolicy.mode === 'supervised' ? 'selected' : ''}>Supervised checkpoints</option></select>${field('validation-repairs', 'Check repair allowance per slice (0–5)', 'number', s.plan.workflowPolicy.repairRounds, 'min="0" max="5" required')}${field('session-turns', 'Start a fresh conversation after this many turns', 'number', s.plan.workflowPolicy.maxSessionTurns, 'min="1" max="50" required')}${field('context-tokens', 'Start fresh at observed context tokens', 'number', s.plan.workflowPolicy.maxContextTokens, 'min="8000" max="1000000" step="1000" required')}<p class="hint">Conversation limits apply to implementers and reviewers at settled retry boundaries. New slices and arbitration always start fresh. Unknown context size falls back to the turn limit.</p><label for="repair-rounds">Repair rounds after blocking reviews</label><select id="repair-rounds" name="repairRounds">${[0, 1, 2].map(n => `<option value="${n}" ${reviewRepairRounds(s.plan) === n ? 'selected' : ''}>${n === 0 ? 'Stop for manual retry' : `${n} repair ${n === 1 ? 'round' : 'rounds'}`}</option>`).join('')}</select><label for="arbitrator">After the repair allowance</label><select id="arbitrator" name="arbitrator"><option value="">Stop for your decision</option>${['codex', 'claude'].map(provider => `<option value="${provider}" ${s.plan.reviewPolicy?.arbitrator?.provider === provider ? 'selected' : ''}>Fresh ${provider} arbitration</option>`).join('')}</select><p class="hint">Automatic repairs keep the approved scope and require a fresh independent verdict. Supervised mode pauses at each checkpoint. An unresolved arbitration stops the task.</p>${field('quality-passes', 'Quality passes (ids, in order)', 'text', s.plan.quality.passes.map(pass => pass.id).join(', '), 'placeholder="none"')}<p class="hint">Available: ${(state.qualityPasses || []).map(pass => `<code>${esc(pass.id)}</code> (${pass.kind === 'lens' ? 'lens' : 'edit'})`).join(', ') || 'none'}. Separate ids with commas; leave empty for none. Lenses are assessed in review; edit passes run before validation in the listed order. Passes already in this plan keep their approved instructions.</p><details><summary>Files, checks, criteria and slices</summary><p class="hint">Edit the execution plan below to change scope or checks. The outcome and approach fields above take precedence.</p><label for="revised-plan">Execution plan (JSON)</label><textarea id="revised-plan" name="plan" rows="14" required>${esc(JSON.stringify(s.plan, null, 2))}</textarea></details><div class="actions"><button type="submit">Prepare revised plan for approval</button></div></form></details></section>`;
}
/** Mirrors the controller: without a review policy, review repairs share the check allowance, up to two. */
function qualityCard(plan) {
  const passes = plan.quality.passes;
  if (!passes.length)
    return '<h3>Quality passes</h3><p class="hint">None selected. Independent review still checks the change; no quality assessment is recorded.</p>';
  return `<h3>Quality passes</h3><p class="hint">Lenses are assessed by the independent reviewer${plan.workflowPolicy.mode === 'supervised' ? ' and recorded from your quality assessment' : ''}. Edit passes run in this order once per slice, after the first successful implementation and before validation; repairs do not run them again.</p>${passes.map(pass => `<details><summary>${esc(pass.title)} · ${pass.kind === 'lens' ? 'review lens' : 'edit pass'} · <code>${esc(pass.id)}</code></summary>${markdown(pass.instructions)}</details>`).join('')}`;
}
function qualityResultsCard(view) {
  const edits = view.state.qualityEdits,
    lenses = view.lenses,
    recorded = view.qualityEvidence;
  if (!edits.length && !lenses.length && !recorded.length) return '';
  const verdicts = lenses
    .map(
      lens =>
        `<h3>${esc(lens.lens)} · ${lens.verdict === 'pass' ? 'passed' : 'failed'}</h3>${markdown(lens.summary)}${lens.findings.map(finding => `<div class="hint">${esc(finding.severity)}</div>${markdown(finding.description)}${code(finding.evidence)}`).join('')}`,
    )
    .join('');
  return `<section class="card"><h2>Quality passes</h2>${edits.map(edit => `<div class="check"><b>${esc(edit.pass)}</b> edit pass · ${edit.before === edit.after ? 'no changes needed' : 'changed the files'}</div>`).join('')}${verdicts}${recorded.length ? `<p class="hint">Recorded assessments: ${recorded.map(item => `${esc(item.pass)} ${esc(item.outcome)} (${item.source === 'agent' ? 'independent reviewer' : 'your assessment'})`).join(' · ')}</p>` : ''}</section>`;
}
function reviewRepairRounds(plan) {
  return plan.reviewPolicy?.repairRounds ?? Math.min(2, plan.workflowPolicy.repairRounds);
}
function reviewPolicyCard(plan) {
  const policy = plan.reviewPolicy;
  const rounds = reviewRepairRounds(plan);
  return `<p class="hint">Review repair allowance: ${rounds} rounds. ${policy?.arbitrator ? `Fresh arbitration: ${esc(policy.arbitrator.provider)}, model ${esc(policy.arbitrator.model || 'provider default')}. No automatic agent time limit.` : 'Unresolved findings stop for your decision.'} ${plan.workflowPolicy.mode === 'automatic' ? 'Repairs continue within the approved scope with a fresh independent verdict.' : 'Each repair requires fresh file authorization and quality assessment.'}</p>`;
}
function usageCard(view) {
  const rows = view.usage ?? [];
  return `<section class="card usage-card"><h2>Measured usage</h2>${
    rows.length
      ? rows
          .map(row => {
            const partial = row.incomplete.length > 0;
            const metric = (field, label, money = false) => {
              const value = row[field];
              const formatted =
                value == null
                  ? 'Unknown'
                  : money
                    ? new Intl.NumberFormat('en-US', {
                        style: 'currency',
                        currency: 'USD',
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 4,
                      }).format(value)
                    : new Intl.NumberFormat('en-US').format(value);
              return `<div><dt>${label}${value != null && row.incomplete.includes(field) ? ' <span class="usage-partial">partial</span>' : ''}</dt><dd>${esc(formatted)}</dd></div>`;
            };
            return `<section class="usage-provider" aria-label="${esc(row.provider)} usage"><div class="usage-heading"><h3>${row.provider === 'claude' ? 'Claude' : 'Codex'}</h3><span class="badge ${row.activeSessions ? 'running' : partial ? '' : 'complete'}">${row.activeSessions ? 'Live · partial' : partial ? 'Partial totals' : 'Complete'}</span></div><dl class="usage-metrics">${metric('inputTokens', 'Input tokens')}${metric('outputTokens', 'Output tokens')}${metric('cachedInputTokens', 'Cached input')}${metric('estimatedCostUsd', 'Estimated cost', true)}</dl><div class="usage-coverage"><span>${row.observedSessions} of ${row.sessions} sessions measured</span><span>Billed cost: unknown</span></div>${partial ? `<p class="hint">${row.activeSessions ? 'Updates during the active turn. ' : ''}${row.observedSessions < row.sessions ? 'Some sessions have no usage observations.' : 'Latest turn measurements are incomplete.'}</p>` : ''}${row.updatedAt ? `<p class="usage-updated">Last observation <time datetime="${esc(row.updatedAt)}" title="${esc(row.updatedAt)}">${esc(new Date(row.updatedAt).toLocaleTimeString())}</time></p>` : ''}</section>`;
          })
          .join('')
      : '<p class="hint">Waiting for provider usage observations.</p>'
  }<p class="hint usage-footnote">Provider token counts have different meanings. Estimated cost uses provider rates; subscription billing may differ.</p></section>`;
}
function taskAction(view) {
  const s = view.state,
    job = state.jobs[selected];
  if (view.stale)
    return notice(
      'The approved plan is stale. Inspect the journal and create a new task with the updated requirements.',
      true,
    );
  if (job?.running)
    return `${taskProgressCard(view)}<div class="actions">${s.owner ? button('stop', s.stopRequested ? 'Stop requested…' : 'Stop now', 'danger') : ''}</div>`;
  if (s.owner || s.pending || s.status === 'recovery_required')
    return `${notice('The previous operation needs reconciliation. Recovery checks saved process and result evidence; it does not replay work.')}<div class="actions">${button('recover', 'Recover saved work', 'primary')}${s.stage === 'workspace' && view.workspace?.adapter === 'git' && view.workspace.phase === 'recovery_required' ? button('release-workspace', 'Release unused reservation') : ''}${s.owner ? button('stop', 'Request stop', 'danger') : ''}</div>`;
  switch (s.status) {
    case 'draft':
      return `<p>Review the outcome, file actions, commands and expected output below. Approval applies to this complete plan and its pinned base.</p><p class="hint">Version ${s.version} · approval digest <code>${esc(s.digest)}</code></p><div class="actions">${button('approve', s.plan.workflowPolicy.mode === 'automatic' ? 'Approve and start' : 'Approve this plan', 'primary')}</div>`;
    case 'ready':
      return `<p>Continue the approved task to its next decision checkpoint.</p><div class="actions">${button('run', 'Continue task →', 'primary')}</div>`;
    case 'awaiting_scope':
      return `<p>Inspect the repository instructions and authorized files below. Authorization starts the implementation and validation steps.</p>${notice(view.scopeError, true)}<div class="actions">${button('authorize', 'Authorize these files and start →', 'primary', view.scopeError ? 'disabled' : '')}${button('retry', 'Refresh file checkpoint')}</div>`;
    case 'awaiting_assessment':
      return `<p>Inspect the changes and check output, then assess them against each quality lens below. Your outcome and summary are recorded for every lens listed.</p>${s.plan.quality.passes
        .filter(pass => pass.kind === 'lens')
        .map(
          pass =>
            `<details><summary>${esc(pass.title)} · <code>${esc(pass.id)}</code></summary>${markdown(pass.instructions)}</details>`,
        )
        .join(
          '',
        )}<form id="assessment-form"><label for="outcome">Quality assessment outcome</label><select id="outcome" name="outcome"><option value="">Choose after inspecting…</option><option value="passed">Passed</option><option value="failed">Failed: changes needed</option><option value="skipped">Skipped: assessment unavailable</option></select><label for="summary">Your assessment</label><textarea id="summary" name="summary" required rows="3" placeholder="Explain what you inspected and why this outcome applies."></textarea><div class="actions"><button class="primary" type="submit">Record assessment and continue →</button>${button('retry', 'Revise implementation')}</div><p class="hint">A pass continues through independent review, acceptance checks and a verified local commit. Failed or skipped assessments stop progression.</p></form>`;
    case 'awaiting_answer':
      return questionsForm(view.questions);
    case 'blocked':
      if (['preparation', 'refresh'].includes(s.stage))
        return `<p>Preparation failed. Inspect its command output below, resolve the cause, then retry this step. The implementation attempt and retained files are preserved.</p><div class="actions">${button('retry', 'Retry preparation', 'primary')}</div>`;
      if (view.rerun)
        return `<p>The check stopped for an infrastructure reason (${esc(s.stopReason?.code || 'check problem')}) and the change has not been edited since. Rerun the same check on the same change, without an agent turn or a new implementation attempt, or retry with a fresh attempt.</p><div class="actions">${button('rerun-checks', 'Rerun checks', 'primary')}${button('retry', 'Retry repair')}</div>`;
      return `<p>${s.stage === 'scope' ? 'File authorization could not be prepared. Inspect the reported path and revise this task’s plan if its file scope is unsupported. Starting a fresh attempt preserves files and uses the same approved scope; it will fail again until the cause is resolved.' : 'Inspect the findings, check output and retained changes. Retrying creates a fresh attempt and preserves existing files.'}</p><div class="actions">${button('retry', 'Retry repair', 'primary')}</div>`;
    case 'complete':
      return `<p>The task passed its gates and was delivered locally. The report retains the checks, reviews, assessments and delivery evidence.</p><div class="actions">${button('report', 'Download task report', 'primary')}</div>`;
    default:
      return notice(s.note || 'Inspect the current task state.');
  }
}
function taskPage() {
  if (!detail || detail.task.id !== selected) return '<p class="muted">Loading task…</p>';
  const view = detail,
    s = view.state;
  const automatic = s.plan.workflowPolicy.mode === 'automatic';
  const assess = s.plan.quality.passes.some(pass => pass.kind === 'lens') ? [['Assess', 'assessment']] : [];
  const stages = [
    ['Plan', 'workspace'],
    ...(s.plan.preparation ? [['Prepare', 'preparation']] : []),
    ['Files', 'scope'],
    ['Implement', 'implementation'],
    ...(s.plan.quality.passes.some(pass => pass.kind === 'edit') ? [['Quality passes', 'quality_pass']] : []),
    ...(s.plan.preparation || s.plan.slices[s.sliceIndex].preparation ? [['Prepare checks', 'refresh']] : []),
    ['Validate', 'validation'],
    ...(automatic ? [['Review', 'review'], ...assess] : [...assess, ['Review', 'review']]),
    ['Accept', 'verification'],
    ['Deliver', 'delivery'],
  ];
  const stageOrder = [
    'workspace',
    'execution',
    'preparation',
    'scope',
    'implementation',
    'quality_pass',
    'refresh',
    'validation',
    'submission',
    'assessment',
    'review_execution',
    'review',
    'verification',
    'delivery',
    'complete',
  ];
  if (automatic) {
    stageOrder.splice(stageOrder.indexOf('assessment'), 1);
    stageOrder.splice(stageOrder.indexOf('verification'), 0, 'assessment');
  }
  const current = stageOrder.indexOf(s.stage);
  const steps = stages
    .map(
      ([name, stage]) =>
        `<div class="step ${s.status === 'complete' || current > stageOrder.indexOf(stage) ? 'done' : current === stageOrder.indexOf(stage) ? 'active' : ''}">${name}</div>`,
    )
    .join('');
  return `<div class="eyebrow">Task / Slice ${s.sliceIndex + 1} of ${s.plan.slices.length}</div><h1>${esc(view.task.brief.title)}</h1>${badge(s.status)}<div class="steps" aria-label="Task progress">${steps}</div>${timelineCard(view)}<div class="columns"><div><section class="card focus"><h2>${esc(label(s.status))}</h2>${s.note ? `<div class="muted">${markdown(humanNote(s.note))}</div>` : ''}${notice(state.jobs[selected]?.error, true)}${stallNotice(view.stalled)}${taskAction(view)}</section>${explorationCard(view.exploration)}${s.status === 'draft' ? planCard(s.plan) : `<section class="card"><details><summary>Approved outcome and execution plan</summary>${planCard(s.plan)}</details></section>`}${s.status === 'awaiting_scope' ? `<section class="card"><h2>Inspect the file authorization</h2>${code(JSON.stringify(s.policy ? { files: s.policy.files, create: s.policy.create, delete: s.policy.delete } : s.plan.slices[s.sliceIndex].scope, null, 2))}<h3>Repository instructions</h3>${s.snapshot.instructions.length ? s.snapshot.instructions.map(item => `<details open><summary>${esc(item.path)}</summary>${code(item.content)}</details>`).join('') : '<p class="muted">No repository instructions were captured.</p>'}<h3>Files in the retained snapshot</h3>${view.scopeFiles.map(file => `<details ${s.policy?.files.includes(file.path) || s.policy?.delete?.includes(file.path) ? 'open' : ''}><summary>${esc(file.path)}</summary>${code(file.content ?? '(absent)')}</details>`).join('')}</section>` : ''}${s.snapshot?.diff.length ? `<section class="card"><h2>Retained changes</h2>${s.snapshot.diff.map(diff => `<details><summary>${esc(diff.path)}</summary><div class="hint">Before · ${esc(diff.previousEncoding)}</div>${code(diff.previousContent ?? '(absent)')}<div class="hint">After · ${esc(diff.encoding)}</div>${code(diff.content ?? '(absent)')}</details>`).join('')}</section>` : ''}${view.findings.length ? `<section class="card"><h2>${view.carriedFindings ? 'Earlier review findings to address' : 'Independent review findings'}</h2>${view.findings.map(finding => `<h3>${esc(finding.severity)}</h3>${markdown(finding.description)}${code(finding.evidence)}`).join('')}</section>` : ''}${qualityResultsCard(view)}${view.checks.length ? `<section class="card"><h2>Preparation, checks and acceptance</h2>${view.checks.map(checkCard).join('')}</section>` : ''}<section class="card"><details><summary>Journal-derived report</summary><div class="markdown report" id="report-content">${loadedReport?.id === selected && loadedReport.key === expected(view) ? window.GrampusMarkdown.render(loadedReport.text) : 'Load or download the report when needed.'}</div>${button('view-report', 'Load report')}${button('report', 'Download Markdown')}</details></section></div><aside>${usageCard(view)}${revisionCard(view)}${managementCard(!!state.jobs[selected]?.running || !!s.owner || !!s.pending || s.status === 'recovery_required')}${referenceCard(view, false)}<section class="card"><h2>Workspace and delivery</h2><dl class="facts"><dt>Workspace</dt><dd>${esc(view.workspace?.path || s.plan.workspace.path || 'Not created yet')}</dd><dt>Implementer</dt><dd>${esc(s.plan.implementation.provider)}</dd><dt>Reviewer</dt><dd>${esc(s.plan.review.provider)}</dd><dt>Version</dt><dd>${s.version}</dd><dt>Delivery</dt><dd>Local only</dd></dl>${view.deliveries.map(delivery => `<div class="check"><b>${esc(delivery.phase)}</b><code>${esc(delivery.commit || delivery.result?.commit || delivery.id)}</code></div>`).join('')}</section>${integrationCard(view.integrations)}</aside></div>`;
}
function render() {
  sessionStorage.setItem('grampus-selection', JSON.stringify({ screen, selected }));
  // Preserve typing and disclosure state while polling updates progress/evidence.
  const kickoff = screen === 'kickoff' ? state.kickoffs.find(item => item.id === selected) : null;
  const decision = screen === 'task' && detail ? expected(detail) : kickoff?.turnKey || '';
  const nextRenderedKey = `${screen}:${selected}:${decision}`;
  const sameItem = renderedKey === nextRenderedKey;
  const timelineScroll = document.getElementById('task-timeline-history')?.scrollTop || 0;
  const inputs = new Map(
    sameItem ? [...app.querySelectorAll('input,textarea,select')].filter(el => el.id).map(el => [el.id, el.value]) : [],
  );
  const open = new Set(
    sameItem ? [...app.querySelectorAll('details[open]')].map(el => el.querySelector('summary')?.textContent) : [],
  );
  const focus = document.activeElement?.id,
    start = document.activeElement?.selectionStart,
    end = document.activeElement?.selectionEnd;
  app.innerHTML = `<div class="shell">${nav()}<main class="main" id="main"><div class="topline"><span>Workspace / ${screen === 'new' ? 'New task' : screen === 'kickoff' ? 'Planning' : screen === 'task' ? 'Task' : 'Overview'}</span><span class="topline-end">${healthIndicator()}<span class="local">Local controller · Windows alpha</span></span></div>${screen === 'new' ? newTask() : screen === 'kickoff' ? kickoffPage() : screen === 'task' ? taskPage() : welcome()}</main></div>`;
  renderedKey = nextRenderedKey;
  const timeline = document.getElementById('task-timeline-history');
  if (timeline && timelineExpandedId === selected) timeline.scrollTop = timelineScroll;
  // Bind controls to their rendered content; never borrow newer polling state at click time.
  for (const control of app.querySelectorAll('button[data-action],form')) {
    control.dataset.expected = decision;
    control.dataset.digest = kickoff?.candidateDigest || detail?.state.digest || '';
    control.dataset.version = String(detail?.state.version || '');
  }
  for (const [id, value] of inputs) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }
  for (const el of app.querySelectorAll('details'))
    if (open.has(el.querySelector('summary')?.textContent)) el.open = true;
  if (focus) {
    const el = document.getElementById(focus);
    if (el) {
      el.focus({ preventScroll: true });
      if (typeof start === 'number' && el.setSelectionRange) {
        try {
          el.setSelectionRange(start, end);
        } catch {}
      }
    }
  }
}
async function refresh(force = false) {
  const serial = ++refreshSerial,
    startedScreen = screen,
    startedId = selected;
  const next = await api('/api/state');
  if (serial !== refreshSerial || startedScreen !== screen || startedId !== selected) return;
  if (
    (screen === 'task' && !next.tasks.some(item => item.id === selected)) ||
    (screen === 'kickoff' && !next.kickoffs.some(item => item.id === selected))
  ) {
    screen = 'home';
    selected = null;
  }
  const targetScreen = screen,
    targetId = selected;
  const nextDetail = screen === 'task' && selected ? await api(`/api/tasks/${selected}`) : null;
  if (serial !== refreshSerial || targetScreen !== screen || targetId !== selected) return;
  if (nextDetail && timelineExpandedId === selected && loadedTimeline?.events.length !== nextDetail.eventCount) {
    const history = await api(`/api/tasks/${selected}/events`);
    if (serial !== refreshSerial || targetScreen !== screen || targetId !== selected) return;
    loadedTimeline = { id: selected, events: history.events };
  }
  const sig = JSON.stringify([next, nextDetail, screen, selected, pending, timelineExpandedId, loadedTimeline]);
  state = next;
  detail = nextDetail;
  if (force || sig !== signature) {
    signature = sig;
    render();
  }
}
async function select(id, type) {
  fileSearch = null;
  loadedReport = null;
  timelineExpandedId = null;
  loadedTimeline = null;
  selected = id;
  screen = type;
  signature = '';
  detail = null;
  await refresh(true);
}
async function act(action, payload = {}) {
  const kind = screen === 'kickoff' ? 'kickoffs' : 'tasks';
  if (action === 'plan') {
    planningRequest = {
      id: selected,
      startedAt: planningRequest?.id === selected ? planningRequest.startedAt : new Date().toISOString(),
    };
    render();
  }
  let result;
  try {
    result = await api(`/api/${kind}/${selected}/${action}`, payload);
  } finally {
    if (action === 'plan') planningRequest = null;
  }
  if (action === 'prepare') {
    await select(result.id, 'task');
    return;
  }
  if (action === 'reset') {
    await select(result.id, 'kickoff');
    await act('plan', { expected: state.kickoffs.find(item => item.id === result.id)?.turnKey });
    return;
  }
  if (action === 'delete') {
    selected = null;
    detail = null;
    screen = 'home';
    await refresh(true);
    return;
  }
  await refresh(true);
}
app.addEventListener('click', async event => {
  const el = event.target.closest('button');
  if (!el || el.disabled || pending) return;
  if (el.dataset.answerTarget) {
    const field = el.form.querySelector(`#${el.dataset.answerTarget}`);
    if (field) {
      field.value = el.dataset.answerValue;
      field.focus();
      field.setSelectionRange(field.value.length, field.value.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  try {
    if (el.dataset.task) {
      await select(el.dataset.task, 'task');
      return;
    }
    if (el.dataset.kickoff) {
      await select(el.dataset.kickoff, 'kickoff');
      return;
    }
    if (el.dataset.referencePath) {
      const field = document.querySelector(screen === 'kickoff' ? '#planner-references' : '#reference-folders');
      const paths = parsePaths(field.value);
      if (!paths.includes(el.dataset.referencePath)) paths.push(el.dataset.referencePath);
      field.value = paths.join('\n');
      return;
    }
    if (el.dataset.contextPath) {
      const field = document.querySelector(screen === 'kickoff' ? '#planner-context-files' : '#context-files');
      const paths = parsePaths(field.value);
      if (!paths.includes(el.dataset.contextPath)) paths.push(el.dataset.contextPath);
      field.value = paths.join('\n');
      return;
    }
    const action = el.dataset.action;
    if (!action) return;
    if (action === 'check-output') {
      const taskId = selected;
      const page = await api(
        `/api/tasks/${taskId}/check-output?checkId=${encodeURIComponent(el.dataset.checkId)}&stream=${el.dataset.stream}&offset=${el.dataset.offset || 0}`,
      );
      if (selected === taskId && screen === 'task') {
        loadedCheck = { ...page, taskId };
        render();
      }
      return;
    }
    if (action === 'toggle-timeline') {
      const id = selected;
      if (timelineExpandedId === id) {
        timelineExpandedId = null;
        render();
        return;
      }
      const history = await api(`/api/tasks/${id}/events`);
      if (screen === 'task' && selected === id) {
        loadedTimeline = { id, events: history.events };
        timelineExpandedId = id;
        render();
      }
      return;
    }
    if (action === 'health-refresh') {
      pending = true;
      render();
      // Runs the inference-free checks again; the next refresh shows the stored result.
      await api('/api/health?refresh=1');
      return;
    }
    if (action === 'suggest-references') {
      const result = await api('/api/references/suggest', { request: document.querySelector('#request').value });
      folderSuggestions = result.suggestions;
      render();
      return;
    }
    if (
      (action === 'reset' || action === 'delete') &&
      !window.confirm(
        action === 'reset'
          ? 'Restart planning from the original request? Existing workspace files and commits will be kept.'
          : 'Delete this task from the dashboard? Existing workspace files, commits and recorded history will be kept.',
      )
    )
      return;
    if (action === 'search-next' || action === 'search-prev') {
      await searchFiles(action === 'search-next' ? fileSearch.nextOffset : Math.max(0, fileSearch.offset - 100));
      return;
    }
    if (action === 'inspect') {
      const values = Object.fromEntries(new FormData(document.querySelector('#kickoff-form')));
      repositoryPreview = await api('/api/repositories/inspect', { repo: values.repo, request: values.request });
      previewInput = values.repo;
      fileSearch = null;
      const field = document.querySelector('#context-files');
      if (field) field.value = repositoryPreview.context.selected.join('\n');
      render();
      return;
    }
    if (action === 'view-report') {
      const id = selected,
        key = expected(detail),
        report = await api(`/api/tasks/${id}/report`);
      loadedReport = { id, key, text: report.report };
      return;
    }
    if (action === 'new') {
      selected = null;
      detail = null;
      repositoryPreview = null;
      fileSearch = null;
      previewInput = '';
      folderSuggestions = [];
      screen = 'new';
      render();
      return;
    }
    if (action === 'open-task') {
      await select(state.kickoffs.find(item => item.id === selected).taskId, 'task');
      return;
    }
    if (action === 'report') {
      const reportId = selected,
        report = await api(`/api/tasks/${reportId}/report`);
      const url = URL.createObjectURL(new Blob([report.report], { type: 'text/markdown;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `grampus-${reportId}.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    pending = true;
    const binding = { expected: el.dataset.expected, digest: el.dataset.digest };
    if (action === 'approve') await act(action, { ...binding, version: Number(el.dataset.version) });
    else await act(action, binding);
  } catch (error) {
    showError(error);
  } finally {
    pending = false;
    await refresh(true).catch(showError);
  }
});
app.addEventListener('submit', async event => {
  event.preventDefault();
  if (pending) return;
  const form = event.target,
    values = Object.fromEntries(new FormData(form));
  const binding = { expected: form.dataset.expected };
  try {
    pending = true;
    if (form.id === 'kickoff-form') {
      const hints =
        repositoryPreview && values.repo === previewInput
          ? { base: repositoryPreview.base, contextFiles: parsePaths(values.contextFiles) }
          : {};
      planningRequest = { id: null, startedAt: new Date().toISOString() };
      render();
      const created = await api('/api/kickoffs', {
        ...values,
        ...hints,
        ...(parsePaths(values.referenceFolders).length ? { references: parsePaths(values.referenceFolders) } : {}),
      });
      planningRequest.id = created.id;
      await select(created.id, 'kickoff');
      await act('plan', { expected: state.kickoffs.find(item => item.id === created.id)?.turnKey });
    } else if (form.id === 'reference-form') {
      await act('references', { references: parsePaths(values.referenceFolders), ...binding });
    } else if (form.id === 'context-search-form') {
      await searchFiles();
    } else if (form.id === 'planner-context-form') {
      await act('context', { files: parsePaths(values.contextFiles), ...binding });
    } else if (form.id === 'import-form') {
      const created = await api('/api/tasks', { plan: JSON.parse(values.plan) });
      await select(created.id, 'task');
    } else if (form.id === 'planner-message-form') {
      await act('plan', { ...values, ...binding });
      form.reset();
    } else if (form.id === 'planner-answer-form') await act('plan', { answers: values, ...binding });
    else if (form.id === 'answer-form') await act('answer', { answers: values, ...binding });
    else if (form.id === 'assessment-form') {
      if (!values.outcome) throw new Error('Choose a quality assessment outcome after inspection');
      await act('assess', { ...values, ...binding });
    } else if (form.id === 'revision-form') {
      const plan = JSON.parse(values.plan);
      plan.brief = { ...plan.brief, title: values.title, outcome: values.outcome, plan: values.approach };
      plan.workflowPolicy = {
        mode: values.workflowMode,
        repairRounds: Number(values['validation-repairs']),
        maxSessionTurns: Number(values['session-turns']),
        maxContextTokens: Number(values['context-tokens']),
      };
      plan.reviewPolicy = {
        repairRounds: Number(values.repairRounds),
        ...(values.arbitrator
          ? {
              arbitrator:
                plan.reviewPolicy?.arbitrator?.provider === values.arbitrator
                  ? plan.reviewPolicy.arbitrator
                  : { provider: values.arbitrator },
            }
          : {}),
      };
      const qualityIds = String(values['quality-passes'] || '')
        .split(',')
        .map(id => id.trim())
        .filter(Boolean);
      plan.quality = { passes: qualityIds.map(id => plan.quality?.passes?.find(pass => pass.id === id) ?? id) };
      await act('revise', { plan, ...binding });
    }
  } catch (error) {
    showError(error);
  } finally {
    pending = false;
    planningRequest = null;
    await refresh(true).catch(showError);
  }
});
refresh(true).catch(showError);
window.addEventListener('hashchange', () => {
  if (!location.hash.slice(1)) return;
  token = location.hash.slice(1);
  sessionStorage.setItem('grampus-token', token);
  history.replaceState(null, '', location.pathname);
  alertBox.hidden = true;
  void refresh(true).catch(showError);
});
setInterval(() => {
  if (!pending) void refresh().catch(showError);
}, 1500);
setInterval(updateProgressTimes, 1000);
