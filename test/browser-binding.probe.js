// Browser regression probe: evaluate this file in a loaded dashboard with a
// selected completed task and at least one saved kickoff. All HTTP requests are
// replaced with offline responses during the probe; no provider/Git work runs.
// Verifies clearing old answers and submitting rendered keys for both workflows.
(async () => {
  const originalFetch = window.fetch, originalScreen = screen, originalSelected = selected;
  const originalState = structuredClone(state), originalDetail = structuredClone(detail);
  const results = {};
  const pause = () => new Promise(resolve => setTimeout(resolve, 25));
  // Freeze periodic refresh while rendering a fixture; an in-flight real poll is
  // invalidated by refreshSerial, and cannot supersede the fixture render.
  const refreshFixture = async () => { pending = true; try { await refresh(true); } finally { pending = false; } };
  try {
    const mock = structuredClone(originalDetail), list = structuredClone(originalState);
    let posted = null;
    window.fetch = async (url, options = {}) => {
      if (options.method === 'POST') { posted = JSON.parse(options.body); return new Response('{}', { status: 202 }); }
      return new Response(JSON.stringify(url === '/api/state' ? list : mock), { status: 200 });
    };
    mock.state.status = 'awaiting_answer'; mock.state.stage = 'review'; mock.state.note = 'Offline browser fixture';
    mock.questionKey = 'review-round-one'; mock.questions = [{ id: 'same-id', prompt: 'First review question?', choices: [] }];
    await refreshFixture();
    document.querySelector('#answer-0').value = 'Answer intended only for the first question';
    mock.questionKey = 'review-round-two'; mock.questions[0].prompt = 'A different review question reusing the same id?';
    await refreshFixture();
    results.taskOldTextCleared = document.querySelector('#answer-0').value === '';
    const form = document.querySelector('#answer-form'), renderedKey = form.dataset.expected;
    document.querySelector('#answer-0').value = 'Current explicit answer';
    detail = structuredClone(mock); detail.questionKey = 'unrendered-newer-round';
    const newerKey = expected(detail);
    form.requestSubmit();
    for (let i = 0; i < 100 && (pending || !posted); i++) await pause();
    results.taskSubmitsRenderedKey = posted?.expected === renderedKey && posted?.expected !== newerKey;

    const kickoff = structuredClone(originalState.kickoffs[0]);
    kickoff.taskId = null; kickoff.candidate = null; kickoff.candidateDigest = null; kickoff.error = null;
    kickoff.turnKey = 'planner-round-one'; kickoff.session.phase = 'awaiting_answer'; kickoff.session.run = null;
    kickoff.session.lastReply = { kind: 'question', text: 'Offline fixture', questions: [{ id: 'same-id', prompt: 'First planning question?', choices: [] }], findings: [] };
    list.kickoffs = [kickoff]; list.jobs = {}; screen = 'kickoff'; selected = kickoff.id;
    await refreshFixture();
    document.querySelector('#answer-0').value = 'Old planning answer';
    kickoff.turnKey = 'planner-round-two'; kickoff.session.lastReply.questions[0].prompt = 'A different planning question reusing the same id?';
    await refreshFixture();
    results.plannerOldTextCleared = document.querySelector('#answer-0').value === '';
    const planningForm = document.querySelector('#planner-answer-form'), planningKey = planningForm.dataset.expected;
    document.querySelector('#answer-0').value = 'Current planning answer';
    state.kickoffs[0].turnKey = 'unrendered-planning-round'; posted = null;
    planningForm.requestSubmit();
    for (let i = 0; i < 100 && (pending || !posted); i++) await pause();
    results.plannerSubmitsRenderedKey = posted?.expected === planningKey && posted?.expected !== 'unrendered-planning-round';
    if (Object.values(results).some(value => !value)) throw new Error(JSON.stringify(results));
    window.__bindingProbe = results;
    return JSON.stringify(results);
  } finally {
    window.fetch = originalFetch; screen = originalScreen; selected = originalSelected;
    pending = false; signature = ''; await refresh(true);
  }
})()
