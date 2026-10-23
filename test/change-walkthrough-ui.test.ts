// Regression tests for the real walkthrough scripts, including delayed API responses and line anchors.
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { reactive } from 'vue';
import { componentSetup } from './helpers/vue-setup.js';

test('diff content beginning with ++ or -- still advances candidate and original line numbers', async t => {
  const component = await componentSetup('web/app/components/DiffFile.vue', {
    path: 'counter.js',
    selected: null,
    highlighted: null,
    patch:
      'diff --git a/counter.js b/counter.js\n--- a/counter.js\n+++ b/counter.js\n@@ -1,2 +1,2 @@\n---old;\n+++next;\n tail\n',
  });
  t.after(component.stop);
  const lines = component.state['lines'] as { text: string; current: number | null; old: number | null }[];
  assert.equal(lines.find(line => line.text === '+++next;')?.current, 1);
  assert.equal(lines.find(line => line.text === '---old;')?.old, 1);
  assert.equal(lines.find(line => line.text === ' tail')?.current, 2);
});

test('a delayed changes response cannot replace a newer candidate', async t => {
  const responses: ((response: Response) => void)[] = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => responses.push(resolve)));
  installStorage(t);
  const props = reactive({
    task: {
      taskId: 'task-1',
      updatedAt: '1',
      worktree: { baseSha: 'base' },
      explanations: [],
      answers: [],
      stages: [],
      commands: [],
    },
  });
  const component = await componentSetup('web/app/components/ChangesTab.vue', props);
  t.after(component.stop);
  props.task.updatedAt = '2';
  await setImmediate();
  assert.equal(responses.length, 2);
  responses[1]?.(Response.json({ baseSha: 'base', sha: 'new', specVersion: 1, files: [] }));
  await setImmediate();
  responses[0]?.(Response.json({ baseSha: 'base', sha: 'old', specVersion: 1, files: [] }));
  await setImmediate();
  assert.equal(component.state['changes'].sha, 'new');

  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => null } });
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'document');
  });
  component.state['chooseCode']({ path: 'one.ts', start: 1, end: 1 });
  await component.state['jump']({ path: 'two.ts', start: 2, end: 2 }, 'older');
  component.state['draftText'] = 'Keep the selected code binding';
  component.state['addDraft']();
  assert.equal(
    component.state['drafts'][0].candidateSha,
    'new',
    'opening an old reference must not rebind selected current code',
  );
});

test('sending feedback preserves requests added or edited while the request is in flight', async t => {
  const replies: ((value: Response) => void)[] = [];
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) =>
    init.method === 'POST'
      ? new Promise<Response>(resolve => replies.push(resolve))
      : Promise.resolve(Response.json({ baseSha: 'base', sha: 'new', specVersion: 1, files: [] })),
  );
  const component = await feedbackSetup(t);
  for (const text of ['Edit this request', 'Send this unchanged']) {
    component.state['draftText'] = text;
    component.state['addDraft']();
  }
  const sending = component.state['submitFeedback']();
  component.state['drafts'][0].text = 'Edited while sending';
  component.state['draftText'] = 'Added while sending';
  component.state['addDraft']();
  replies[0]?.(Response.json({}));
  await sending;
  assert.deepEqual(
    component.state['drafts'].map((draft: { text: string }) => draft.text),
    ['Edited while sending', 'Added while sending'],
  );
});

test('an emptied change request cannot trigger a repair round', async t => {
  let posts = 0;
  t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    if (init.method === 'POST') posts++;
    return Promise.resolve(Response.json({ baseSha: 'base', sha: 'new', specVersion: 1, files: [] }));
  });
  const component = await feedbackSetup(t);
  component.state['draftText'] = 'Changed my mind';
  component.state['addDraft']();
  component.state['drafts'][0].text = '  ';
  await component.state['submitFeedback']();
  assert.equal(posts, 0);
  assert.match(component.state['error'], /request.*text/i);
});

async function feedbackSetup(t: TestContext) {
  installStorage(t);
  const component = await componentSetup('web/app/components/ChangesTab.vue', {
    task: {
      taskId: 'task-1',
      updatedAt: '1',
      worktree: { baseSha: 'base' },
      explanations: [],
      answers: [],
      stages: [],
      commands: [],
      needsYou: { options: ['continue'] },
    },
  });
  t.after(component.stop);
  await setImmediate();
  return component;
}

function installStorage(t: TestContext): void {
  const storage = new Map<string, string>();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
    },
  });
}
