// Ensures controller timing includes non-provider work and distinguishes unfinished steps.
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WorkflowTiming from './WorkflowTiming.vue';

describe('WorkflowTiming', () => {
  it('shows total, stages, waiting, recovery and individual execution status', () => {
    const wrapper = mount(WorkflowTiming, {
      props: {
        timing: {
          startedAt: '2026-10-20T10:00:00Z',
          completedAt: null,
          asOf: '2026-10-20T10:01:00Z',
          elapsedMs: 60000,
          activeMs: 40000,
          waitingMs: 15000,
          recoveryMs: 5000,
          live: true,
          clockAdjusted: false,
          stages: [{ stage: 'readiness', elapsedMs: 40000, activeMs: 40000, waitingMs: 0, recoveryMs: 0, steps: 1 }],
          steps: [
            {
              sequence: 1,
              sliceIndex: 0,
              stage: 'readiness',
              startedAt: '2026-10-20T10:00:00Z',
              finishedAt: null,
              activeMs: 40000,
              waitingMs: 0,
              recoveryMs: 0,
            },
          ],
        },
      },
    });
    expect(wrapper.text()).toContain('Total elapsed:');
    expect(wrapper.text()).toContain('(live)');
    expect(wrapper.text()).toContain('readiness');
    expect(wrapper.text()).toContain('Waiting');
    expect(wrapper.text()).toContain('Recovery');
    expect(wrapper.text()).toContain('Pending');
  });
});
