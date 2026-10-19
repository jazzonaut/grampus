// Shared helpers for tests that drive a running dashboard through HTTP the way the Vue client does: read
// the v1 views, take an action's `ActionView.request` and post it, and wait for an action worker to settle.
import assert from 'node:assert/strict';
import type { startUi } from '../../src/server/ui-server.js';
import type { ActionId, ActionView, KickoffDetailV1, OverviewV1, TaskDetailV1 } from '../../src/server/api-types.js';

type Dashboard = Awaited<ReturnType<typeof startUi>>;

/** HTTP access to one running dashboard with its token. */
export function connect(ui: Dashboard) {
  const url = new URL(ui.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' };
  const raw = (path: string) => fetch(url.origin + path, { headers });
  const read = async <T>(path: string): Promise<T> => {
    const response = await raw(path);
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    return (await response.json()) as T;
  };
  const post = (path: string, body: unknown) =>
    fetch(url.origin + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return {
    origin: url.origin,
    token: url.hash.slice(1),
    raw,
    read,
    post,
    overview: () => read<OverviewV1>('/api/v1/overview'),
    task: (id: string) => read<TaskDetailV1>(`/api/v1/tasks/${id}`),
    kickoff: (id: string) => read<KickoffDetailV1>(`/api/v1/kickoffs/${id}`),
    /** Posts an action exactly as the view offers it, with `body` fields merged over its request body. */
    act: (action: ActionView, body: Record<string, unknown> = {}) =>
      post(action.request.path, { ...action.request.body, ...body }),
  };
}

/** The action `id` a view offers; fails the test when it is missing. */
export function offered(view: { decisions: ActionView[] } | { actions: ActionView[] }, id: ActionId): ActionView {
  const actions = 'decisions' in view ? view.decisions : view.actions;
  const found = actions.find(action => action.id === id);
  assert.ok(found, `${id} is not offered: ${actions.map(action => action.id).join(', ')}`);
  return found;
}

/** Waits until the dashboard's worker for `id` has settled, and returns it. */
export async function settled(ui: Dashboard, id: string, timeoutMs = 45_000): Promise<ReturnType<Dashboard['job']>> {
  const deadline = Date.now() + timeoutMs;
  while (ui.job(id)?.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  const job = ui.job(id);
  assert.ok(!job?.running, 'Worker did not settle');
  return job;
}
