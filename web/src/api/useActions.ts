// Sending actions truthfully. No optimism on durable operations: after the server accepts an action the
// page says "requested" until a fresh view differs from the one the action was chosen on, and only then
// shows the new state. A 409 means the page was stale: it refetches and says so calmly. A full runner pool
// (409 `pool_full`, or an approval answered with `started: false`) is a wait, not a failure. Nothing is
// retried or queued.
import { computed, onScopeDispose, ref, watch } from 'vue';
import type { AcceptedResponse, ActionView } from '../../../src/server/api-types';
import { announce } from '../announcer';
import { requestedPatienceMs } from '../settings';
import { buildRequest, type FieldIssue, type FormDrafts } from './actions';
import { ApiError, request } from './client';

/** What the page tells the person about the last action. */
export type ActionNotice =
  | { kind: 'requested'; actionId: string; message: string }
  | { kind: 'waiting'; actionId: string; message: string }
  | { kind: 'stale'; message: string }
  /** Every runner slot is taken: the action did not start (an approval still stands). */
  | { kind: 'pool'; actionId: string; message: string }
  | { kind: 'error'; actionId: string; message: string; issues: readonly string[] };

export interface ActionsOptions {
  /** Fetch the view again now. */
  refresh: () => Promise<void>;
  /** A fingerprint of the displayed state; "requested" ends when it changes. */
  signature: () => string | undefined;
  /** Called with the response of an accepted action, e.g. to open a created task. */
  accepted?: (action: ActionView, response: unknown) => void;
}

/** The notice for a refused stale action. */
export const staleMessage =
  'This changed since the page was shown, so Grampus did not act on it. The page now shows the current state: check it and choose again.';

/** The notice when an action could not start because every runner slot is taken. */
export const poolFullMessage =
  'Every runner slot is in use, so this did not start and nothing was queued. Try again once another task finishes.';

/** The notice when an automatic plan was approved while every runner slot is taken. */
export const approvedWaitingMessage =
  'Approved. Every runner slot is in use, so the task is waiting for a free slot: choose Continue task once another task finishes.';

/** An approval the server accepted without starting a worker because the runner pool is full. */
function approvedWithoutStart(response: unknown): boolean {
  return typeof response === 'object' && response !== null && (response as Partial<AcceptedResponse>).started === false;
}

/** Sends `ActionView`s for one screen and tracks what to tell the person. */
export function useActions(options: ActionsOptions) {
  const sending = ref<string | null>(null);
  const notice = ref<ActionNotice | null>(null);
  const fieldIssues = ref<{ actionId: string; issues: FieldIssue[] } | null>(null);
  let chosenOn: string | undefined;
  let patience: ReturnType<typeof setTimeout> | undefined;

  const clearPatience = (): void => {
    if (patience !== undefined) clearTimeout(patience);
    patience = undefined;
  };

  watch(options.signature, current => {
    if (notice.value?.kind !== 'requested' && notice.value?.kind !== 'waiting') return;
    if (current === chosenOn) return;
    clearPatience();
    notice.value = null;
    announce('The task state changed.');
  });
  onScopeDispose(clearPatience);

  function requested(action: ActionView): void {
    notice.value = {
      kind: 'requested',
      actionId: action.id,
      message: `${action.label}: requested. Waiting for Grampus to confirm it.`,
    };
    announce(notice.value.message);
    clearPatience();
    patience = setTimeout(() => {
      if (notice.value?.kind === 'requested')
        notice.value = {
          kind: 'waiting',
          actionId: action.id,
          message: `${action.label} was accepted, but the state shown has not changed yet. It was not repeated; check the timeline below or wait.`,
        };
    }, requestedPatienceMs);
  }

  async function failed(action: ActionView, error: unknown): Promise<void> {
    const apiError = error instanceof ApiError ? error : new ApiError(0, String(error));
    if (apiError.unauthorised) return;
    if (apiError.poolFull) {
      notice.value = { kind: 'pool', actionId: action.id, message: poolFullMessage };
      announce(poolFullMessage);
      await options.refresh();
      return;
    }
    if (apiError.stale) {
      notice.value = { kind: 'stale', message: staleMessage };
      announce(staleMessage);
      await options.refresh();
      return;
    }
    notice.value = { kind: 'error', actionId: action.id, message: apiError.message, issues: apiError.issues };
    announce(`${action.label} failed: ${apiError.message}`);
  }

  /** Sends one action with the entered drafts. Returns whether the server accepted it. */
  async function run(action: ActionView, drafts: FormDrafts = {}): Promise<boolean> {
    if (sending.value !== null || !action.enabled) return false;
    const built = buildRequest(action, drafts);
    if (!built.ok) {
      fieldIssues.value = { actionId: action.id, issues: built.issues };
      return false;
    }
    fieldIssues.value = null;
    sending.value = action.id;
    chosenOn = options.signature();
    try {
      const response = await request<unknown>(built.method, built.path, built.body);
      if (approvedWithoutStart(response)) {
        clearPatience();
        notice.value = { kind: 'pool', actionId: action.id, message: approvedWaitingMessage };
        announce(approvedWaitingMessage);
      } else requested(action);
      options.accepted?.(action, response);
      await options.refresh();
      return true;
    } catch (error) {
      await failed(action, error);
      return false;
    } finally {
      sending.value = null;
    }
  }

  /** The issues of one action's form, after a submit with problems. */
  const issuesFor = (actionId: string): FieldIssue[] =>
    fieldIssues.value?.actionId === actionId ? fieldIssues.value.issues : [];

  return {
    run,
    sending: computed(() => sending.value),
    notice: computed(() => notice.value),
    /** True while an action is sent or waits for the server to reflect it; action buttons stay disabled. */
    busy: computed(() => sending.value !== null || notice.value?.kind === 'requested'),
    issuesFor,
    dismiss: () => {
      notice.value = null;
    },
  };
}
