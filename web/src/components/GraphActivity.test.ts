// Recorded status controls motion; replay and stale reads must never look live.
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import GraphConnector from './GraphConnector.vue';
import GraphParticipant from './GraphParticipant.vue';
import { activityEvent } from '../testing';
import { graphFrame } from '../observability/graph';

let mounted: VueWrapper | undefined;
afterEach(() => mounted?.unmount());

function frame() {
  return graphFrame(
    [{ id: 'agent:s', kind: 'agent', label: 'Planner', detail: 'planning', status: 'active' }],
    [activityEvent('request', { label: 'Searching the repository' })],
    true,
  );
}

describe('graph activity indicators', () => {
  it('renders directional traffic only for a live unfinished connector', async () => {
    const edge = frame().edges[0]!;
    mounted = mount(GraphConnector, { props: { edge, path: 'M 0 0 L 100 0', markerId: 'arrow', live: true } });
    expect(mounted.find('.network-traffic').exists()).toBe(true);
    expect(mounted.get('.network-link').attributes('marker-end')).toBe('url(#arrow)');
    expect(mounted.get('title').text()).toContain('Searching the repository');
    await mounted.setProps({ live: false });
    expect(mounted.find('.network-traffic').exists()).toBe(false);
    await mounted.setProps({ live: true, edge: { ...edge, active: false } });
    expect(mounted.find('.network-traffic').exists()).toBe(false);
  });

  it('shows the active operation, pulse and keyboard selection, then settles visibly', async () => {
    const node = frame().nodes[0]!;
    mounted = mount(GraphParticipant, { props: { node, x: 0, y: 0, live: true } });
    expect(mounted.get('.node-state').text()).toBe('Live · agent');
    expect(mounted.get('.node-activity').text()).toBe('Searching the repository');
    expect(mounted.find('.activity-halo').exists()).toBe(true);
    expect(mounted.attributes('aria-label')).toContain('Searching the repository');
    await mounted.trigger('keydown', { key: 'Enter' });
    expect(mounted.emitted('select')).toEqual([['agent:s']]);
    await mounted.setProps({ live: false });
    expect(mounted.find('.activity-halo').exists()).toBe(false);
    expect(mounted.get('.node-state').text()).toBe('active · agent');
    await mounted.setProps({ live: true, node: { ...node, status: 'completed' } });
    expect(mounted.find('.activity-halo').exists()).toBe(false);
    expect(mounted.get('.node-state').text()).toBe('completed · agent');
  });
});
