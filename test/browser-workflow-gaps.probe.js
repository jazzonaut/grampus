// Evaluate in a loaded development dashboard with a saved guided task.
// Every request is mocked; no inference, Git writes or real task changes occur.
(async () => {
  const original = {
    fetch: window.fetch,
    screen,
    selected,
    state: structuredClone(state),
    detail: structuredClone(detail),
  };
  const results = {},
    calls = [],
    pause = () => new Promise(resolve => setTimeout(resolve, 25));
  const settle = async () => {
    for (let i = 0; i < 200 && pending; i++) await pause();
    if (pending) throw new Error('UI action did not settle');
  };
  try {
    const saved = state.tasks[0];
    if (!saved) throw new Error('A saved guided task is required');
    const response = await original.fetch.call(window, `/api/tasks/${saved.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const fixture = await response.json();
    fixture.state.status = 'draft';
    fixture.state.owner = null;
    fixture.state.pending = null;
    fixture.state.plan.reviewPolicy = {
      repairRounds: 1,
      arbitrator: { provider: 'codex', model: null, timeoutMs: 120000 },
    };
    delete fixture.state.plan.slices[0].acceptance.expectedStdout;
    fixture.state.plan.slices[0].acceptance.expectations = {
      stdoutJson: { ok: true },
      files: [{ path: 'greeting.js', content: 'hello' }],
    };
    fixture.usageSummary = ['codex: input tokens 240 (partial); billed cost unknown.'];
    fixture.carriedFindings = true;
    fixture.findings = [
      {
        severity: 'blocking',
        description: 'Retain this finding during repair',
        evidence: 'Concrete retained evidence',
      },
    ];
    const list = { ...structuredClone(state), tasks: [saved], kickoffs: [], jobs: {} };
    window.fetch = async (url, options = {}) => {
      calls.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : null });
      return new Response(
        JSON.stringify(url === '/api/state' ? list : url === `/api/tasks/${saved.id}` ? fixture : {}),
        { status: 200 },
      );
    };
    ++refreshSerial;
    pending = false;
    screen = 'task';
    selected = saved.id;
    state = list;
    detail = fixture;
    renderedKey = '';
    render();
    results.structuredAcceptanceVisible =
      document.body.textContent.includes('Additional acceptance observations') &&
      document.body.textContent.includes('stdoutJson');
    results.partialUsageVisible =
      document.body.textContent.includes('240 (partial)') && document.body.textContent.includes('billed cost unknown');
    results.repairFindingsRemainVisible =
      document.body.textContent.includes('Earlier review findings to address') &&
      document.body.textContent.includes('Concrete retained evidence');
    const form = document.querySelector('#revision-form');
    form.closest('details').open = true;
    results.labeledRevisionControls = [
      'revision-title',
      'revision-outcome',
      'revision-approach',
      'repair-rounds',
      'arbitrator',
      'revised-plan',
    ].every(id => !!document.querySelector(`label[for="${id}"]`) && !!document.getElementById(id));
    const key = form.dataset.expected;
    document.querySelector('#revision-title').value = 'Revised browser greeting';
    document.querySelector('#revision-outcome').value = 'The revised output contract';
    document.querySelector('#repair-rounds').value = '2';
    document.querySelector('#arbitrator').value = 'claude';
    form.requestSubmit();
    await settle();
    const revision = calls.find(call => call.url.endsWith('/revise'));
    results.revisionUsesRenderedApprovalState = revision?.body.expected === key;
    results.revisionKeepsIdentityAndNewPolicy =
      revision?.body.plan.workspace.repo === fixture.state.plan.workspace.repo &&
      revision.body.plan.brief.outcome === 'The revised output contract' &&
      revision.body.plan.reviewPolicy.repairRounds === 2 &&
      revision.body.plan.reviewPolicy.arbitrator.provider === 'claude';
    results.revisionDoesNotRunImplementation = !calls.some(call => /\/(run|authorize|assess|plan)$/.test(call.url));
    fixture.state.status = 'recovery_required';
    fixture.state.stage = 'workspace';
    fixture.workspace = { adapter: 'git', phase: 'recovery_required', path: null };
    detail = fixture;
    renderedKey = '';
    render();
    const release = document.querySelector('[data-action="release-workspace"]');
    results.unusedReservationActionVisible = release?.textContent === 'Release unused reservation';
    const releaseKey = release.dataset.expected;
    release.click();
    await settle();
    results.releaseUsesRenderedState =
      calls.find(call => call.url.endsWith('/release-workspace'))?.body.expected === releaseKey;
    if (Object.values(results).some(value => !value)) throw new Error(JSON.stringify(results));
    window.__workflowGapsProbe = results;
    return JSON.stringify(results);
  } finally {
    window.fetch = original.fetch;
    screen = original.screen;
    selected = original.selected;
    state = original.state;
    detail = original.detail;
    pending = false;
    renderedKey = '';
    signature = '';
    await refresh(true);
  }
})();
