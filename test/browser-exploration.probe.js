// Evaluate in a loaded dashboard with a saved kickoff and completed task.
// All HTTP requests are replaced with offline fixtures; no provider work runs.
(async () => {
  const original = {
    fetch: window.fetch,
    screen,
    selected,
    state: structuredClone(state),
    detail: structuredClone(detail),
    repositoryPreview,
    previewInput,
    fileSearch,
  };
  const pause = () => new Promise(resolve => setTimeout(resolve, 25));
  const calls = [],
    results = {};
  try {
    const kickoff = structuredClone(state.kickoffs[0]);
    if (!kickoff) throw new Error('A saved kickoff is required');
    kickoff.taskId = null;
    kickoff.candidate = null;
    kickoff.candidateDigest = null;
    kickoff.session.run = null;
    kickoff.session.phase = 'idle';
    kickoff.session.lastReply = null;
    kickoff.messages = [];
    kickoff.exploration = { calls: 3, readFiles: ['src/unhinted-dependency.js'], latestTool: 'grampus_read_file' };
    const list = { ...state, kickoffs: [kickoff], jobs: {} };
    window.fetch = async (url, options = {}) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      if (url === '/api/kickoffs' && options.method === 'POST')
        return new Response(JSON.stringify({ id: kickoff.id }), { status: 201 });
      return new Response(JSON.stringify(url === '/api/state' ? list : {}), { status: 200 });
    };
    pending = true;
    ++refreshSerial;
    screen = 'new';
    selected = null;
    repositoryPreview = null;
    previewInput = '';
    detail = null;
    renderedKey = '';
    render();
    pending = false;
    renderedKey = '';
    render();
    results.directStartButton =
      document.querySelector('#kickoff-form button[type=submit]').textContent === 'Start planning';
    results.optionalHintsCollapsed = [...document.querySelectorAll('#kickoff-form details')].some(
      el => el.querySelector('summary')?.textContent === 'Optional file hints' && !el.open,
    );
    document.querySelector('#repo').value = 'C:/offline-fixture';
    document.querySelector('#request').value = 'Investigate the dependency and change the behavior';
    document.querySelector('#kickoff-form button[type=submit]').click();
    for (let i = 0; i < 150 && (pending || !calls.some(call => call.url.endsWith('/plan'))); i++) await pause();
    results.singleStepKickoff =
      calls.filter(call => call.url === '/api/kickoffs' && call.method === 'POST').length === 1 &&
      !calls.some(call => call.url === '/api/repositories/inspect');
    results.noSelectionRequired = !Object.hasOwn(calls.find(call => call.url === '/api/kickoffs').body, 'contextFiles');
    results.explorationVisible =
      document.body.textContent.includes('src/unhinted-dependency.js') &&
      document.body.textContent.includes('3 search, list and read calls');
    results.repositoryAccessExplained = document.body.textContent.includes(
      'The planner can search and read the pinned repository itself',
    );
    if (Object.values(results).some(value => !value)) throw new Error(JSON.stringify(results));
    window.__explorationProbe = results;
    return JSON.stringify(results);
  } finally {
    window.fetch = original.fetch;
    screen = original.screen;
    selected = original.selected;
    state = original.state;
    detail = original.detail;
    repositoryPreview = original.repositoryPreview;
    previewInput = original.previewInput;
    fileSearch = original.fileSearch;
    pending = false;
    renderedKey = '';
    signature = '';
    await refresh(true);
  }
})();
