const app = document.querySelector('#app'), alertBox = document.querySelector('#error');
const fragment = location.hash.slice(1);
if (fragment) { sessionStorage.setItem('grampus-token', fragment); history.replaceState(null, '', location.pathname); }
let token = sessionStorage.getItem('grampus-token') || '';
let state = { tasks: [], kickoffs: [], jobs: {}, journal: '' }, selected = null, detail = null, screen = 'home', signature = '', pending = false;
let renderedKey = '';
let repositoryPreview = null, previewInput = '', fileSearch = null, loadedReport = null;
let refreshSerial = 0;
try { const saved = JSON.parse(sessionStorage.getItem('grampus-selection') || 'null'); if (saved && ['task', 'kickoff'].includes(saved.screen)) { selected = saved.selected; screen = saved.screen; } } catch {}
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const pretty = value => esc(JSON.stringify(value, null, 2));
const names = { draft: 'Plan ready for approval', ready: 'Ready to continue', running: 'Working', awaiting_scope: 'File approval needed', awaiting_assessment: 'Simplification review needed', awaiting_answer: 'Your answer is needed', blocked: 'Needs attention', recovery_required: 'Recovery needed', complete: 'Delivered locally', idle: 'Plan ready', failed: 'Planning stopped', interrupted: 'Interrupted', stop_requested: 'Stopping' };
const label = value => names[value] || value?.replaceAll('_', ' ') || '';
const humanNote = text => String(text || '').replace(/task-authorize/g, 'the file authorization button').replace(/task-answer/g, 'the answer form').replace(/task-assess/g, 'the simplification form').replace(/task-retry/g, 'a fresh attempt').replace(/task-recover/g, 'Recover saved work').replace(/task-run/g, 'Continue task').replace(/task-show/g, 'the task details');
const badge = value => `<span class="badge ${esc(value)}">${esc(label(value))}</span>`;
const button = (action, text, cls = '', attributes = '') => `<button type="${attributes.includes('submit') ? 'submit' : 'button'}" data-action="${action}" class="${cls}" ${pending ? 'disabled' : ''} ${attributes}>${text}</button>`;
const code = text => `<pre>${esc(text)}</pre>`;
const notice = (text, error = false) => text ? `<div class="notice${error ? ' error' : ''}">${esc(text)}</div>` : '';
const field = (id, title, type = 'text', value = '', extra = '') => `<label for="${id}">${title}</label><input id="${id}" name="${id}" type="${type}" value="${esc(value)}" ${extra}>`;
function showError(error) { alertBox.textContent = error.message || String(error); alertBox.hidden = false; }
alertBox.addEventListener('click', () => { alertBox.hidden = true; });
async function api(path, payload) {
  const response = await fetch(path, { method: payload === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function nav() {
  const items = state.tasks.map(task => `<button class="navitem ${selected === task.id ? 'selected' : ''}" data-task="${esc(task.id)}"><span class="dot ${esc(task.status)}"></span>${esc(task.title)}<small>${esc(label(task.status))}</small></button>`).join('');
  const kickoffs = state.kickoffs.filter(item => !item.taskId).map(item => `<button class="navitem ${selected === item.id ? 'selected' : ''}" data-kickoff="${esc(item.id)}">${esc(item.config.request.slice(0, 70))}<small>${esc(label(item.session.phase))}</small></button>`).join('');
  const info = state.application;
  return `<aside class="sidebar"><div class="brand"><span class="mark">g</span>grampus</div><button class="new" data-action="new">＋ New task</button><div class="eyebrow">Tasks</div>${items || '<p class="empty">Your tasks will appear here.</p>'}${kickoffs ? `<div class="eyebrow">Planning</div>${kickoffs}` : ''}<footer>WINDOWS ALPHA${info ? `<br>v${esc(info.version)} · ${esc(info.channel)}${info.build ? `<br><span title="${esc(info.build.builtAt)}">Build ${esc(info.build.id)}</span>` : ''}` : ''}<br>Local work. Independent review.<br>Your journal survives restarts.</footer></aside>`;
}
function welcome() {
  return `<div class="welcome"><div class="eyebrow">Your local coding workspace</div><h1>A clear brief.<br>A checked, reviewed change.</h1><p class="lead muted">Describe what you want to change. Grampus helps clarify the details, prepares a plan, and guides the work through to a local commit.</p><div class="actions">${button('new', 'Start a task →', 'primary')}</div><div class="intro-grid"><section class="card"><span class="eyebrow">01 / Plan</span><b>Agree on the outcome</b><p>Discuss the task and review the files, checks and examples before approving.</p></section><section class="card"><span class="eyebrow">02 / Work</span><b>Keep the evidence</b><p>Follow implementation, simplification, independent review and acceptance in one place.</p></section><section class="card"><span class="eyebrow">03 / Deliver</span><b>Stay in control</b><p>Answer questions, request a stop or recover interrupted work. Delivery stays local.</p></section></div></div>`;
}
function newTask() {
  return `<div class="eyebrow">Task kickoff</div><h1>What would you like to change?</h1><p class="muted lead">Start with the outcome. The planner reads the committed repository and asks about details that could change the result.</p><div class="columns"><section class="card focus"><h2>Describe the task</h2><form id="kickoff-form">${field('repo', 'Repository folder', 'text', '', 'required placeholder="C:\\Projects\\my-project"')}<p class="hint">An existing Git repository with a committed baseline. Inspect the pinned commit and select relevant text files. Other files remain covered by artifact verification.</p><label for="request">What should be different when this is done?</label><textarea id="request" name="request" rows="6" required placeholder="Describe the behavior, include a few examples, and say what should stay the same."></textarea><div class="row"><div><label for="provider">Planner and implementer</label><select id="provider" name="provider"><option value="codex">Codex</option><option value="claude">Claude</option></select></div><div><label for="adapter">Workspace</label><select id="adapter" name="adapter"><option value="git">Standalone Git worktree</option><option value="orca">Local Orca worktree</option></select></div></div><label for="timeoutMs">Time limit per agent turn</label><select id="timeoutMs" name="timeoutMs"><option value="120000">2 minutes</option><option value="300000" selected>5 minutes</option><option value="600000">10 minutes</option></select>${repositoryPreview ? contextFields(repositoryPreview.context, false) : ''}<div class="actions"><button class="primary" type="submit" ${pending ? 'disabled' : ''}>${repositoryPreview ? 'Discuss using selected context' : 'Inspect repository context'}</button>${repositoryPreview ? button('inspect', 'Refresh suggestions') : ''}</div></form>${repositoryPreview ? searchCard() : ''}</section><aside><section class="card"><h2>Before work begins</h2><p class="muted">Planning uses your existing subscription login. You’ll review the complete plan and authorize the exact files before implementation starts.</p><p class="hint">The other provider reviews the result. No automatic inference retries. Commits stay local.</p></section><section class="card"><details><summary>Already have a guided plan?</summary><form id="import-form"><label for="plan-json">Import plan JSON</label><textarea id="plan-json" name="plan" rows="9" required></textarea><div class="actions"><button type="submit">Import for approval</button></div></form></details></section></aside></div>`;
}
function contextFields(context, planner) {
  const paths = context?.selected || [];
  return `<h3>Repository context</h3><p class="hint">${context.totalFiles.toLocaleString()} files in the pinned commit; ${paths.length} selected; ${context.omittedFiles.toLocaleString()} omitted from agent context.</p><p class="hint">Suggestions use filenames and your task description; they do not prove dependency coverage. Include relevant callers, tests and configuration. Review always includes changed files and instructions. Context budget: 256 text files, 256 KiB each, 512 KiB total.</p><label for="${planner ? 'planner-context-files' : 'context-files'}">Exact context paths, one per line</label><textarea id="${planner ? 'planner-context-files' : 'context-files'}" name="contextFiles" rows="8">${esc(paths.join('\n'))}</textarea><details><summary>Repository map and omission record</summary>${code(context.directories.map(item => `${item.path}: ${item.files} files`).join('\n'))}<p class="hint">Every path outside the selected list is omitted from prompts. Search the full inventory below. Inventory digest: ${esc(context.inventoryDigest)}</p></details>`;
}
function searchCard() {
  return `<section class="context-search"><h3>Search the pinned file inventory</h3><form id="context-search-form"><label for="context-query">Path contains</label><input id="context-query" name="query" placeholder="e.g. src greeting"><div class="actions"><button type="submit">Search files</button></div></form>${fileSearch ? `<p class="hint">${fileSearch.matches.toLocaleString()} matches; showing ${fileSearch.offset + (fileSearch.files.length ? 1 : 0)} to ${fileSearch.offset + fileSearch.files.length}</p><div class="file-results">${fileSearch.files.map(file => `<button type="button" data-context-path="${esc(file.path)}">Add ${esc(file.path)} <small>${file.bytes.toLocaleString()} bytes</small></button>`).join('')}</div><div class="actions">${fileSearch.offset ? button('search-prev', 'Previous 100') : ''}${fileSearch.nextOffset !== null ? button('search-next', 'Next 100') : ''}</div>` : ''}</section>`;
}
const parsePaths = value => String(value || '').split(/\r?\n/).map(path => path.trim()).filter(Boolean);
async function searchFiles(offset = 0) {
  const config = screen === 'kickoff' ? state.kickoffs.find(item => item.id === selected)?.config : repositoryPreview;
  if (!config) throw new Error('Inspect a repository first');
  const query = document.querySelector('#context-query')?.value || '';
  fileSearch = await api('/api/repositories/files', { repo: config.repo, base: config.base, query, offset }); render();
}
function planCard(plan) {
  return `<section class="card"><h2>The proposed plan</h2><p>${esc(plan.brief.outcome)}</p>${plan.context ? `<h3>Approved repository context</h3><p class="hint">${plan.context.files.length} supplied files out of ${plan.context.totalFiles.toLocaleString()}. Other files are omitted from prompts and remain covered by artifact verification. Review also includes every changed file and repository instructions.</p>${code(plan.context.files.join('\n'))}` : ''}<h3>Acceptance criteria</h3><ul>${plan.brief.criteria.map(item => `<li>${esc(item)}</li>`).join('')}</ul><h3>Approach</h3><p>${esc(plan.brief.plan)}</p><dl class="facts"><dt>Repository</dt><dd>${esc(plan.workspace.repo)}</dd><dt>Base commit</dt><dd><code>${esc(plan.workspace.base)}</code></dd><dt>Workspace</dt><dd>${esc(plan.workspace.path || 'Created through Orca')}</dd><dt>Agents</dt><dd>${esc(plan.implementation.provider)} implements · ${esc(plan.review.provider)} reviews<br>Models: ${esc(plan.implementation.model || 'provider default')} / ${esc(plan.review.model || 'provider default')}<br>Timeouts: ${plan.implementation.timeoutMs / 1000}s / ${plan.review.timeoutMs / 1000}s</dd></dl>${plan.slices.map((slice, index) => `<h3>Slice ${index + 1} · ${esc(plan.brief.slices?.[index]?.title || plan.brief.title)}</h3>${plan.brief.slices?.[index] ? `<p>${esc(plan.brief.slices[index].plan)}</p><ul>${plan.brief.slices[index].criteria.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}<div class="hint">Files to edit</div>${code(slice.scope.files.join('\n') || '(none)')}${slice.scope.create?.length ? `<div class="hint">Files to create</div>${code(slice.scope.create.join('\n'))}` : ''}${slice.scope.delete?.length ? `<div class="hint">Files to delete</div>${code(slice.scope.delete.join('\n'))}` : ''}<div class="hint">Validation · ${esc(slice.validation.name)} · ${slice.validation.timeoutMs / 1000}s</div>${commandCard(slice.validation)}<div class="hint">Acceptance · ${esc(slice.acceptance.name)} · ${slice.acceptance.timeoutMs / 1000}s</div>${commandCard(slice.acceptance)}<div class="hint">Exact expected stdout (JSON escaped)</div>${code(JSON.stringify(slice.acceptance.expectedStdout))}<p class="hint">Delivery: ${esc(slice.mode)} · ${esc(slice.message)}</p>`).join('')}</section>`;
}
function commandCard(command) {
  return `<div class="hint">Executable</div>${code(command.file)}${command.args.map((arg, index) => `<div class="hint">Argument ${index + 1}</div>${code(arg)}`).join('')}<details><summary>Exact argument array</summary>${code(JSON.stringify(command.args))}</details>`;
}
function questionsForm(questions, kickoff = false) {
  return `<form id="${kickoff ? 'planner-answer-form' : 'answer-form'}">${questions.map((question, index) => `<label for="answer-${index}">${esc(question.prompt)}</label>${question.choices.length ? `<p class="hint">Suggestions: ${question.choices.map(esc).join(' · ')}</p>` : ''}<textarea id="answer-${index}" name="${esc(question.id)}" rows="2" required></textarea>`).join('')}<div class="actions"><button class="primary" type="submit">Send answers and continue →</button></div></form>`;
}
function kickoffPage() {
  const item = state.kickoffs.find(item => item.id === selected);
  if (!item) return welcome();
  const job = state.jobs[item.id], active = job?.running || ['running', 'stop_requested'].includes(item.session.phase);
  const uncertain = item.session.run || item.session.phase === 'recovery_required';
  return `<div class="eyebrow">Planning conversation</div><h1>Shape the task before starting.</h1>${badge(active ? 'running' : item.session.phase)}<div class="columns"><div><section class="card focus"><h2>Discussion</h2>${item.messages.map(message => {
    let text = message.text;
    if (message.role === 'user') { try { const answers = JSON.parse(text); if (answers && !Array.isArray(answers) && typeof answers === 'object' && Object.values(answers).every(value => typeof value === 'string')) text = Object.values(answers).join('\n'); } catch {} }
    if (message.role === 'assistant') { try { const raw = JSON.parse(text); if (raw.brief) text = `I’ve prepared a plan for “${raw.brief.title}”. Review its scope and checks below, or ask for changes.`; } catch {} }
    return `<div class="message"><span class="eyebrow">${message.role === 'user' ? 'You' : esc(item.config.provider)}</span>${esc(text)}</div>`;
  }).join('') || `<p>${esc(item.config.request)}</p>`}${notice(item.error, true)}${notice(job?.error, true)}${active ? notice('The planner is working. You can leave this page; progress is saved locally.') + (item.session.run ? `<div class="actions">${button('stop', item.session.phase === 'stop_requested' ? 'Stop requested…' : 'Stop planning', 'danger')}</div>` : '') : ''}${item.taskId ? `<div class="actions">${button('open-task', 'Open task →', 'primary')}</div>` : !active && uncertain ? `${notice('The earlier planner still owns its session. Recovery must prove that its processes exited.')}<div class="actions">${button('planner-recover', 'Recover planning session')}</div>` : !active ? item.session.phase === 'awaiting_answer' ? questionsForm(item.session.lastReply.questions, true) : `<form id="planner-message-form"><label for="revision">${item.messages.length ? 'Refine the plan' : 'Start planning'}</label><textarea id="revision" name="message" rows="3" ${item.messages.length ? 'required' : ''} placeholder="Ask for changes or add an example…"></textarea><div class="actions"><button type="submit">${item.messages.length ? 'Send message' : 'Prepare a plan'}</button>${item.candidate && !item.error && item.session.phase === 'idle' ? button('prepare', 'Review for approval →', 'primary') : ''}</div></form>` : ''}</section>${item.candidate ? planCard(item.candidate) : ''}</div><aside><section class="card"><h2>Planning context</h2><dl class="facts"><dt>Repository</dt><dd>${esc(item.config.repo)}</dd><dt>Base</dt><dd><code>${esc(item.config.base)}</code></dd><dt>Provider</dt><dd>${esc(item.config.provider)}</dd><dt>Workspace</dt><dd>${esc(item.config.adapter)}</dd></dl><h3>Files supplied to the planner</h3>${code(item.config.files.join('\n'))}${!active && !uncertain && !item.taskId && item.config.context ? `<form id="planner-context-form">${contextFields(item.config.context, true)}<div class="actions"><button type="submit">Update context</button></div><p class="hint">Updating invalidates the previous proposal and starts no inference. Send a message or answer current questions to plan with the new context.</p></form>${searchCard()}` : ''}<p class="hint">This is a draft conversation. Preparing a task does not approve it or start implementation.</p></section></aside></div>`;
}
function expected(view) {
  const s = view.state;
  return JSON.stringify({ version: s.version, digest: s.digest, status: s.status, stage: s.stage, artifact: s.snapshot?.artifact ?? null, instructionsDigest: s.snapshot?.instructionsDigest ?? null, executionId: s.executionId, reviewId: s.reviewId, questionKey: view.questionKey ?? null });
}
function taskAction(view) {
  const s = view.state, job = state.jobs[selected];
  if (view.stale) return notice('The approved plan is stale. Inspect the journal and create a new task with the updated requirements.', true);
  if (job?.running) return `${notice('Working through the approved plan. Progress and evidence update here.')}<div class="actions">${s.owner ? button('stop', s.stopRequested ? 'Stop requested…' : 'Stop now', 'danger') : ''}</div>`;
  if (s.owner || s.pending || s.status === 'recovery_required') return `${notice('The previous operation needs reconciliation. Recovery checks saved process and result evidence; it does not replay work.')}<div class="actions">${button('recover', 'Recover saved work', 'primary')}${s.owner ? button('stop', 'Request stop', 'danger') : ''}</div>`;
  switch (s.status) {
    case 'draft': return `<p>Review the outcome, file actions, commands and expected output below. Approval applies to this complete plan and its pinned base.</p><p class="hint">Version ${s.version} · approval digest <code>${esc(s.digest)}</code></p><div class="actions">${button('approve', 'Approve this plan', 'primary')}</div>`;
    case 'ready': return `<p>Continue the approved task to its next decision checkpoint.</p><div class="actions">${button('run', 'Continue task →', 'primary')}</div>`;
    case 'awaiting_scope': return `<p>Inspect the repository instructions and authorized files below. Authorization starts the implementation and validation steps.</p>${notice(view.scopeError, true)}<div class="actions">${button('authorize', 'Authorize these files and start →', 'primary', view.scopeError ? 'disabled' : '')}${button('retry', 'Refresh file checkpoint')}</div>`;
    case 'awaiting_assessment': return `<p>Inspect the changes and check output. Record whether the implementation is simple, follows repository patterns, and avoids unnecessary abstractions.</p><form id="assessment-form"><label for="outcome">Simplification outcome</label><select id="outcome" name="outcome"><option value="">Choose after inspecting…</option><option value="passed">Passed</option><option value="failed">Failed — changes needed</option><option value="skipped">Skipped — assessment unavailable</option></select><label for="summary">Your assessment</label><textarea id="summary" name="summary" required rows="3" placeholder="Explain what you inspected and why this outcome applies."></textarea><div class="actions"><button class="primary" type="submit">Record assessment and continue →</button>${button('retry', 'Revise implementation')}</div><p class="hint">A pass continues through independent review, acceptance checks and a verified local commit. Failed or skipped assessments stop progression.</p></form>`;
    case 'awaiting_answer': return questionsForm(view.questions);
    case 'blocked': return `<p>Inspect the findings, check output and retained changes. Retrying creates a fresh attempt and preserves existing files.</p><div class="actions">${button('retry', 'Start a fresh attempt', 'primary')}</div>`;
    case 'complete': return `<p>The task passed its gates and was delivered locally. The report retains the checks, reviews, assessments and delivery evidence.</p><div class="actions">${button('report', 'Download task report', 'primary')}</div>`;
    default: return notice(s.note || 'Inspect the current task state.');
  }
}
function taskPage() {
  if (!detail || detail.task.id !== selected) return '<p class="muted">Loading task…</p>';
  const view = detail, s = view.state;
  const stages = [['Plan','workspace'],['Files','scope'],['Implement','implementation'],['Validate','validation'],['Simplify','assessment'],['Review','review'],['Accept','verification'],['Deliver','delivery']];
  const stageOrder = ['workspace','execution','scope','implementation','validation','submission','assessment','review_execution','review','verification','delivery','complete'];
  const current = stageOrder.indexOf(s.stage);
  const steps = stages.map(([name, stage]) => `<div class="step ${s.status === 'complete' || current > stageOrder.indexOf(stage) ? 'done' : current === stageOrder.indexOf(stage) ? 'active' : ''}">${name}</div>`).join('');
  return `<div class="eyebrow">Task / Slice ${s.sliceIndex + 1} of ${s.plan.slices.length}</div><h1>${esc(view.task.brief.title)}</h1>${badge(s.status)}<div class="steps" aria-label="Task progress">${steps}</div><div class="columns"><div><section class="card focus"><h2>${esc(label(s.status))}</h2>${s.note ? `<p class="muted">${esc(humanNote(s.note))}</p>` : ''}${notice(state.jobs[selected]?.error, true)}${taskAction(view)}</section>${s.status === 'draft' ? planCard(s.plan) : `<section class="card"><details><summary>Approved outcome and execution plan</summary>${planCard(s.plan)}</details></section>`}${s.status === 'awaiting_scope' ? `<section class="card"><h2>Inspect the file authorization</h2>${code(JSON.stringify(s.policy ? { files: s.policy.files, create: s.policy.create, delete: s.policy.delete } : s.plan.slices[s.sliceIndex].scope, null, 2))}<h3>Repository instructions</h3>${s.snapshot.instructions.length ? s.snapshot.instructions.map(item => `<details open><summary>${esc(item.path)}</summary>${code(item.content)}</details>`).join('') : '<p class="muted">No repository instructions were captured.</p>'}<h3>Files in the retained snapshot</h3>${view.scopeFiles.map(file => `<details ${s.policy?.files.includes(file.path) || s.policy?.delete?.includes(file.path) ? 'open' : ''}><summary>${esc(file.path)}</summary>${code(file.content ?? '(absent)')}</details>`).join('')}</section>` : ''}${s.snapshot?.diff.length ? `<section class="card"><h2>Retained changes</h2>${s.snapshot.diff.map(diff => `<details open><summary>${esc(diff.path)}</summary><div class="hint">Before · ${esc(diff.previousEncoding)}</div>${code(diff.previousContent ?? '(absent)')}<div class="hint">After · ${esc(diff.encoding)}</div>${code(diff.content ?? '(absent)')}</details>`).join('')}</section>` : ''}${view.findings.length ? `<section class="card"><h2>Independent review findings</h2>${view.findings.map(finding => `<h3>${esc(finding.severity)}</h3><p>${esc(finding.description)}</p>${code(finding.evidence)}`).join('')}</section>` : ''}${view.checks.length ? `<section class="card"><h2>Checks and acceptance</h2>${view.checks.map(check => `<details ${check.phase !== 'passed' ? 'open' : ''}><summary>${esc(check.spec.name)} · ${esc(check.phase)}</summary>${check.error ? notice(check.error, true) : ''}<div class="hint">stdout</div>${code(check.result?.stdout ?? '(unavailable)')}<div class="hint">stderr</div>${code(check.result?.stderr ?? '(unavailable)')}</details>`).join('')}</section>` : ''}<section class="card"><details><summary>Journal-derived report</summary><pre class="report" id="report-content">${loadedReport?.id === selected && loadedReport.key === expected(view) ? esc(loadedReport.text) : 'Load or download the report when needed.'}</pre>${button('view-report', 'Load report')}${button('report', 'Download Markdown')}</details></section></div><aside><section class="card"><h2>Workspace and delivery</h2><dl class="facts"><dt>Workspace</dt><dd>${esc(view.workspace?.path || s.plan.workspace.path || 'Not created yet')}</dd><dt>Implementer</dt><dd>${esc(s.plan.implementation.provider)}</dd><dt>Reviewer</dt><dd>${esc(s.plan.review.provider)}</dd><dt>Version</dt><dd>${s.version}</dd><dt>Delivery</dt><dd>Local only</dd></dl>${view.deliveries.map(delivery => `<div class="check"><b>${esc(delivery.phase)}</b><code>${esc(delivery.commit || delivery.result?.commit || delivery.id)}</code></div>`).join('')}</section><section class="card"><h2>Task timeline</h2><ol class="timeline">${view.events.slice(-30).reverse().map(event => `<li><time>${esc(new Date(event.at).toLocaleTimeString())}</time>${esc(event.type.replaceAll('.', ' · ').replaceAll('_', ' '))}${event.data?.note ? `<div class="muted">${esc(humanNote(event.data.note))}</div>` : ''}</li>`).join('')}</ol></section></aside></div>`;
}
function render() {
  sessionStorage.setItem('grampus-selection', JSON.stringify({ screen, selected }));
  // Preserve typing and disclosure state while polling updates progress/evidence.
  const kickoff = screen === 'kickoff' ? state.kickoffs.find(item => item.id === selected) : null;
  const decision = screen === 'task' && detail ? expected(detail) : kickoff?.turnKey || '';
  const nextRenderedKey = `${screen}:${selected}:${decision}`;
  const sameItem = renderedKey === nextRenderedKey;
  const inputs = new Map(sameItem ? [...app.querySelectorAll('input,textarea,select')].filter(el => el.id).map(el => [el.id, el.value]) : []);
  const open = new Set(sameItem ? [...app.querySelectorAll('details[open]')].map(el => el.querySelector('summary')?.textContent) : []);
  const focus = document.activeElement?.id, start = document.activeElement?.selectionStart, end = document.activeElement?.selectionEnd;
  app.innerHTML = `<div class="shell">${nav()}<main class="main" id="main"><div class="topline"><span>Workspace / ${screen === 'new' ? 'New task' : screen === 'kickoff' ? 'Planning' : screen === 'task' ? 'Task' : 'Overview'}</span><span class="local">Local controller · Windows alpha</span></div>${screen === 'new' ? newTask() : screen === 'kickoff' ? kickoffPage() : screen === 'task' ? taskPage() : welcome()}</main></div>`;
  renderedKey = nextRenderedKey;
  // Bind controls to their rendered content; never borrow newer polling state at click time.
  for (const control of app.querySelectorAll('button[data-action],form')) {
    control.dataset.expected = decision;
    control.dataset.digest = kickoff?.candidateDigest || detail?.state.digest || '';
    control.dataset.version = String(detail?.state.version || '');
  }
  for (const [id, value] of inputs) { const el = document.getElementById(id); if (el) el.value = value; }
  for (const el of app.querySelectorAll('details')) if (open.has(el.querySelector('summary')?.textContent)) el.open = true;
  if (focus) { const el = document.getElementById(focus); if (el) { el.focus({ preventScroll: true }); if (typeof start === 'number' && el.setSelectionRange) { try { el.setSelectionRange(start, end); } catch {} } } }
}
async function refresh(force = false) {
  const serial = ++refreshSerial, startedScreen = screen, startedId = selected;
  const next = await api('/api/state');
  if (serial !== refreshSerial || startedScreen !== screen || startedId !== selected) return;
  if (screen === 'task' && !next.tasks.some(item => item.id === selected) || screen === 'kickoff' && !next.kickoffs.some(item => item.id === selected)) { screen = 'home'; selected = null; }
  const targetScreen = screen, targetId = selected;
  const nextDetail = screen === 'task' && selected ? await api(`/api/tasks/${selected}`) : null;
  if (serial !== refreshSerial || targetScreen !== screen || targetId !== selected) return;
  const sig = JSON.stringify([next, nextDetail, screen, selected, pending]);
  state = next; detail = nextDetail;
  if (force || sig !== signature) { signature = sig; render(); }
}
async function select(id, type) { fileSearch = null; loadedReport = null; selected = id; screen = type; signature = ''; detail = null; await refresh(true); }
async function act(action, payload = {}) {
  const kind = screen === 'kickoff' ? 'kickoffs' : 'tasks';
  const result = await api(`/api/${kind}/${selected}/${action}`, payload);
  if (action === 'prepare') { await select(result.id, 'task'); return; }
  await refresh(true);
}
app.addEventListener('click', async event => {
  const el = event.target.closest('button'); if (!el || el.disabled || pending) return;
  try {
    if (el.dataset.task) { await select(el.dataset.task, 'task'); return; }
    if (el.dataset.kickoff) { await select(el.dataset.kickoff, 'kickoff'); return; }
    if (el.dataset.contextPath) {
      const field = document.querySelector(screen === 'kickoff' ? '#planner-context-files' : '#context-files');
      const paths = parsePaths(field.value); if (!paths.includes(el.dataset.contextPath)) paths.push(el.dataset.contextPath); field.value = paths.join('\n'); return;
    }
    const action = el.dataset.action; if (!action) return;
    if (action === 'search-next' || action === 'search-prev') { await searchFiles(action === 'search-next' ? fileSearch.nextOffset : Math.max(0, fileSearch.offset - 100)); return; }
    if (action === 'inspect') {
      const values = Object.fromEntries(new FormData(document.querySelector('#kickoff-form')));
      repositoryPreview = await api('/api/repositories/inspect', { repo: values.repo, request: values.request }); previewInput = values.repo; fileSearch = null;
      const field = document.querySelector('#context-files'); if (field) field.value = repositoryPreview.context.selected.join('\n'); render(); return;
    }
    if (action === 'view-report') { const id = selected, key = expected(detail), report = await api(`/api/tasks/${id}/report`); loadedReport = { id, key, text: report.report }; return; }
    if (action === 'new') { selected = null; detail = null; repositoryPreview = null; fileSearch = null; previewInput = ''; screen = 'new'; render(); return; }
    if (action === 'open-task') { await select(state.kickoffs.find(item => item.id === selected).taskId, 'task'); return; }
    if (action === 'report') {
      const reportId = selected, report = await api(`/api/tasks/${reportId}/report`);
      const url = URL.createObjectURL(new Blob([report.report], { type: 'text/markdown;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `grampus-${reportId}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    pending = true;
    const binding = { expected: el.dataset.expected, digest: el.dataset.digest };
    if (action === 'approve') await act(action, { ...binding, version: Number(el.dataset.version) });
    else await act(action, binding);
  } catch (error) { showError(error); }
  finally { pending = false; await refresh(true).catch(showError); }
});
app.addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return;
  const form = event.target, values = Object.fromEntries(new FormData(form));
  const binding = { expected: form.dataset.expected };
  try {
    pending = true;
    if (form.id === 'kickoff-form') {
      if (!repositoryPreview || values.repo !== previewInput) {
        repositoryPreview = await api('/api/repositories/inspect', { repo: values.repo, request: values.request }); previewInput = values.repo; fileSearch = null; render(); return;
      }
      const created = await api('/api/kickoffs', { ...values, base: repositoryPreview.base, contextFiles: parsePaths(values.contextFiles) }); await select(created.id, 'kickoff'); await act('plan', { expected: state.kickoffs.find(item => item.id === created.id)?.turnKey });
    } else if (form.id === 'context-search-form') { await searchFiles(); }
    else if (form.id === 'planner-context-form') { await act('context', { files: parsePaths(values.contextFiles), ...binding }); }
    else if (form.id === 'import-form') {
      const created = await api('/api/tasks', { plan: JSON.parse(values.plan) }); await select(created.id, 'task');
    } else if (form.id === 'planner-message-form') { await act('plan', { ...values, ...binding }); form.reset(); }
    else if (form.id === 'planner-answer-form') await act('plan', { answers: values, ...binding });
    else if (form.id === 'answer-form') await act('answer', { answers: values, ...binding });
    else if (form.id === 'assessment-form') { if (!values.outcome) throw new Error('Choose a simplification outcome after inspection'); await act('assess', { ...values, ...binding }); }
  } catch (error) { showError(error); }
  finally { pending = false; await refresh(true).catch(showError); }
});
refresh(true).catch(showError);
window.addEventListener('hashchange', () => {
  if (!location.hash.slice(1)) return;
  token = location.hash.slice(1); sessionStorage.setItem('grampus-token', token);
  history.replaceState(null, '', location.pathname); alertBox.hidden = true;
  void refresh(true).catch(showError);
});
setInterval(() => { if (!pending) void refresh().catch(showError); }, 1500);
