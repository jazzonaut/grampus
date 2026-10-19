// Screen selection through the URL fragment: `#/`, `#/new`, `#/health`, `#/tasks/<id>` and
// `#/planning/<id>`. The startup link also uses the fragment, for the access token; api/client.ts moves a
// token into session storage and clears the fragment before routing reads it, so the two never mix (a
// route always starts with `/`, which a token never contains). Back and forward work, and a reload keeps
// the open screen.
import { readonly, ref } from 'vue';

/** The screens of the dashboard. */
export type Route =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'health' }
  | { name: 'task'; id: string }
  | { name: 'planning'; id: string }
  | { name: 'not-found'; path: string };

/** Record ids are UUIDs; letters, digits and dashes only, so a fragment can never smuggle a path. */
const id = /^[A-Za-z0-9-]{1,64}$/;

/** The route a fragment names. An empty fragment is the home screen. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  if (path === '/' || path === '') return { name: 'home' };
  if (path === '/new') return { name: 'new' };
  if (path === '/health') return { name: 'health' };
  const [, kind, value] = /^\/(tasks|planning)\/([^/]+)$/.exec(path) ?? [];
  if (kind && value && id.test(value))
    return kind === 'tasks' ? { name: 'task', id: value } : { name: 'planning', id: value };
  return { name: 'not-found', path };
}

/** The fragment of a route, for links: `<a :href="href(route)">`. */
export function href(route: Exclude<Route, { name: 'not-found' }>): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'new':
      return '#/new';
    case 'health':
      return '#/health';
    case 'task':
      return `#/tasks/${route.id}`;
    case 'planning':
      return `#/planning/${route.id}`;
  }
}

const current = ref<Route>({ name: 'home' });

/** The open screen. Updated on `hashchange` by {@link syncRoute}. */
export const route = readonly(current);

/** Reads the fragment into {@link route}; call at start and on every `hashchange`. */
export function syncRoute(): void {
  current.value = parseRoute(window.location.hash);
}

/** Opens a screen, adding a history entry so Back returns to the previous one. */
export function navigate(to: Exclude<Route, { name: 'not-found' }>): void {
  const target = href(to);
  if (window.location.hash === target) {
    syncRoute();
    return;
  }
  window.location.hash = target;
  syncRoute();
}
