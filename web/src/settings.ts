// Client timing constants in one place. None of them is a workflow rule: the server decides what happens;
// these only pace how often the dashboard asks and how long it waits before saying so.

/** How often the visible view is fetched again (the server caches by journal revision). */
export const pollIntervalMs = 1500;

/** How often elapsed and last-activity times are redrawn. */
export const clockTickMs = 1000;

/**
 * After an action is accepted, how long the dashboard shows "requested" before saying that the server has
 * not reflected it yet. The action itself is not retried or cancelled.
 */
export const requestedPatienceMs = 20_000;

/** Paths a file search page holds; the server pages in steps of this size. */
export const fileSearchPage = 100;

/** Timeline entries fetched per page when the full history is open. */
export const timelinePageEntries = 50;

/** How long a downloaded report's object URL is kept, so the browser can start the download first. */
export const downloadUrlLifetimeMs = 1000;
