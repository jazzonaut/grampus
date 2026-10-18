// Evaluate in the dashboard with a saved kickoff. Requests are mocked throughout;
// this probe starts no provider work and changes no real tasks or files.
(async () => {
  const original = { fetch: window.fetch, confirm: window.confirm, screen, selected, state: structuredClone(state), detail: structuredClone(detail) };
  const results = {}, calls = [], pause = () => new Promise(resolve => setTimeout(resolve, 25));
  const settle = async () => { for (let i = 0; i < 200 && pending; i++) await pause(); if (pending) throw new Error('UI action did not settle'); };
  try {
    const item = structuredClone(state.kickoffs[0]);
    if (!item) throw new Error('A saved kickoff is required');
    item.taskId = null; item.session.phase = 'idle'; item.session.run = null; item.messages = []; item.error = null; item.candidate = null;
    item.turnKey = 'rendered-planning-key'; item.config.references = [];
    item.referenceSuggestions = [{ path: 'C:/offline reference', reason: 'Existing PDF implementation' }];
    item.integrations = [{ name: 'linear', status: 'connected', tools: 82 }];
    const list = { ...structuredClone(state), tasks: [], kickoffs: [item], jobs: {} };
    window.fetch = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, method: options.method, body });
      if (url.endsWith('/references')) { item.config.references = body.references.map(path => ({ path, totalFiles: 1, base: null, digest: 'fixture' })); item.turnKey = 'updated-planning-key'; }
      if (url.endsWith('/delete')) list.kickoffs = [];
      if (url.endsWith('/reset')) {
        const fresh = structuredClone(item); fresh.id = 'fresh-kickoff'; fresh.turnKey = 'fresh-planning-key'; list.kickoffs = [fresh];
        return new Response(JSON.stringify({ id: fresh.id }), { status: 200 });
      }
      return new Response(JSON.stringify(url === '/api/state' ? list : {}), { status: 200 });
    };
    pending = true; ++refreshSerial; screen = 'kickoff'; selected = item.id; detail = null; state = list;
    pending = false; renderedKey = ''; render();
    results.connectionStatusVisible = document.body.textContent.includes('linear') && document.body.textContent.includes('82 tools');
    document.querySelector('[data-reference-path]').click();
    results.agentSuggestionAddsPath = document.querySelector('#planner-references').value === 'C:/offline reference';
    document.querySelector('#reference-form button[type=submit]').click(); await settle();
    const referencePost = calls.find(call => call.url.endsWith('/references'));
    results.referenceUpdateBoundToRenderedState = referencePost?.body.expected === 'rendered-planning-key'
      && referencePost.body.references[0] === 'C:/offline reference' && !calls.some(call => call.url.endsWith('/plan'));
    window.confirm = () => false;
    document.querySelector('[data-action=delete]').click(); await settle();
    results.cancelDoesNotDelete = !calls.some(call => call.url.endsWith('/delete'));
    window.confirm = () => true;
    document.querySelector('[data-action=delete]').click(); await settle();
    results.deleteUsesCurrentKeyAndReturnsHome = calls.find(call => call.url.endsWith('/delete'))?.body.expected === 'updated-planning-key'
      && screen === 'home' && state.kickoffs.length === 0;
    list.kickoffs = [item]; await select(item.id, 'kickoff');
    document.querySelector('[data-action=reset]').click(); await settle();
    results.resetStartsFreshPlanning = screen === 'kickoff' && selected === 'fresh-kickoff'
      && calls.find(call => call.url.endsWith('/reset'))?.body.expected === 'updated-planning-key'
      && calls.find(call => call.url === '/api/kickoffs/fresh-kickoff/plan')?.body.expected === 'fresh-planning-key';
    const fresh = list.kickoffs[0]; fresh.session.phase = 'running'; fresh.session.run = { id: 'fixture-run' };
    pending = true; await refresh(true); pending = false;
    results.activeTaskManagementDisabled = document.querySelector('[data-action=reset]').disabled && document.querySelector('[data-action=delete]').disabled;
    if (Object.values(results).some(value => !value)) throw new Error(JSON.stringify(results));
    window.__taskManagementProbe = results;
    return JSON.stringify(results);
  } finally {
    window.fetch = original.fetch; window.confirm = original.confirm; screen = original.screen; selected = original.selected; state = original.state; detail = original.detail;
    pending = false; renderedKey = ''; signature = ''; await refresh(true);
  }
})()
