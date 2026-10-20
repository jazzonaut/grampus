import { describe, expect, it } from 'vitest';
import { href, parseRoute } from './router';

describe('routes', () => {
  it('reads every screen from the fragment', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/')).toEqual({ name: 'home' });
    expect(parseRoute('#/new')).toEqual({ name: 'new' });
    expect(parseRoute('#/health')).toEqual({ name: 'health' });
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('#/tasks/0f1e-aa')).toEqual({ name: 'task', id: '0f1e-aa' });
    expect(parseRoute('#/planning/abc')).toEqual({ name: 'planning', id: 'abc' });
    expect(parseRoute('#/tasks/abc/observability')).toEqual({ name: 'observability', kind: 'task', id: 'abc' });
  });

  it('treats unknown paths and odd ids as not found', () => {
    expect(parseRoute('#/tasks/../x').name).toBe('not-found');
    expect(parseRoute('#/tasks/<script>').name).toBe('not-found');
    expect(parseRoute('#/nothing').name).toBe('not-found');
  });

  it('round-trips links', () => {
    expect(parseRoute(href({ name: 'task', id: 'abc' }))).toEqual({ name: 'task', id: 'abc' });
    const task = { name: 'observability', kind: 'task', id: 'abc' } as const;
    expect(parseRoute(href(task))).toEqual(task);
  });

  it('opens planning observability with its planning navigation context', () => {
    const target = { name: 'observability', kind: 'planning', id: 'abc' } as const;
    expect(parseRoute('#/planning/abc/observability')).toEqual(target);
    expect(href(target)).toBe('#/planning/abc/observability');
  });
});
