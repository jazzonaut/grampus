// The command catalog: every `grampus` command with its arguments and a one-line summary. The CLI's usage
// text and the dashboard's Help page both render it, so the two never drift apart.

/** How the Help page groups commands. */
export type CommandGroup = 'tasks' | 'decisions' | 'evidence' | 'setup';

export interface CommandInfo {
  name: string;
  /** Arguments as typed after the name, in usage notation. */
  args: string;
  summary: string;
  group: CommandGroup;
  /** Optional longer explanation for the Help page. */
  detail?: string;
}

export const commandGroups: Record<CommandGroup, string> = {
  tasks: 'Start and follow tasks',
  decisions: 'Decisions (queued for the task driver)',
  evidence: 'Evidence and delivery',
  setup: 'Setup and internals',
};

export const commands: readonly CommandInfo[] = [
  {
    name: 'new',
    args: '[--repo <path>] [--recipe <name>] [--title <text>] <request...>',
    summary: "Start a task (repository: --repo or the current folder's)",
    group: 'tasks',
    detail: 'Creates the task log, an Orca worktree and the terminal that runs its driver.',
  },
  {
    name: 'compare',
    args: '[--repo <path>] --recipes <a,b,...> [--mode full|shared] [--title <text>] <request...>',
    summary: 'Run one request under several recipes from the same base commit',
    group: 'tasks',
    detail:
      'Full mode (default) runs each recipe end to end and cross-checks every result against every spec; shared mode writes one spec in the first entry and builds every recipe from it.',
  },
  { name: 'status', args: '[task] [--json]', summary: 'Show tasks, or one task in detail', group: 'tasks' },
  {
    name: 'wait',
    args: '[task] [--after <time>] [--json]',
    summary: 'Block until something newer than --after needs you',
    group: 'tasks',
  },
  {
    name: 'dashboard',
    args: '[--port <n>]',
    summary: 'Serve the dashboard on this machine and the local network',
    group: 'tasks',
  },
  {
    name: 'approve',
    args: '<task> [--version <n>]',
    summary: 'Approve the latest (or given) spec version',
    group: 'decisions',
  },
  { name: 'revise', args: '<task> <feedback...>', summary: 'Ask the spec writer for a revision', group: 'decisions' },
  { name: 'reply', args: '<task> <message-id> <answer...>', summary: "Answer a worker's question", group: 'decisions' },
  {
    name: 'continue',
    args: '<task> <guidance...>',
    summary: 'Run another repair round with guidance',
    group: 'decisions',
  },
  {
    name: 'retry',
    args: '<task>',
    summary: 'Retry a stage that failed to start, exited or went quiet',
    group: 'decisions',
  },
  { name: 'accept', args: '<task>', summary: "Accept the task's verified branch", group: 'decisions' },
  {
    name: 'abandon',
    args: '<task> [reason...]',
    summary: 'Abandon the task and release its workers',
    group: 'decisions',
  },
  {
    name: 'pick',
    args: '<comparison> <task>',
    summary: 'Keep one comparison entry; the others end as not selected',
    group: 'decisions',
    detail: '`abandon <comparison>` abandons every entry of a comparison instead.',
  },
  {
    name: 'report',
    args: '<task> [--json]',
    summary: 'Models, time, tokens and estimated cost per stage, and human cost',
    group: 'evidence',
  },
  {
    name: 'merge',
    args: '<task>',
    summary: "Fast-forward your checked-out branch to an accepted task's commit",
    group: 'evidence',
    detail: 'Never pushes. Refuses when the branch has moved on or the checkout has uncommitted changes.',
  },
  {
    name: 'remove',
    args: '<task> [--worktree] [--force]',
    summary: 'Delete a finished task and its evidence; --worktree removes its worktree too',
    group: 'evidence',
    detail:
      'Refused while its driver runs and for comparison entries. --force also removes an unfinished task whose driver cannot run (its workers are not stopped) and discards uncommitted changes in its worktree. Orca keeps the task branch unless it is merged.',
  },
  { name: 'recipes', args: '', summary: 'List recipes', group: 'setup' },
  {
    name: 'update',
    args: '[--from <checkout>] [--dirty]',
    summary: 'Install what is committed in the checkout Grampus was installed from',
    group: 'setup',
    detail:
      'Builds and installs that checkout as a new version and selects it; it never fetches or pulls. Does nothing when the checkout holds the running build.',
  },
  {
    name: 'version',
    args: '[--json]',
    summary: 'Show the running build and where it is installed',
    group: 'setup',
    detail: '`grampus --version` prints the same.',
  },
  {
    name: 'skill',
    args: '[install]',
    summary: 'Print the chat skill, or install it for Claude and Codex (installed builds only)',
    group: 'setup',
  },
  {
    name: 'drive-comparison',
    args: '<comparison>',
    summary: "Run a comparison's driver (Grampus starts it in Orca)",
    group: 'setup',
  },
  {
    name: 'drive',
    args: '<task>',
    summary: "Run a task's driver (Grampus starts it in Orca)",
    group: 'setup',
  },
];

/** Options every command accepts. */
export const globalOptions = '--home <dir> (data directory), --source cli|chat|dashboard (who is acting; default cli)';

/** The CLI's usage text. */
export function usageText(): string {
  const width = Math.max(...commands.map(command => `${command.name} ${command.args}`.trimEnd().length));
  const lines = commands.map(
    command => `  ${`${command.name} ${command.args}`.trimEnd().padEnd(width)} ${command.summary}`,
  );
  return `Usage: grampus <command> [options]\n\n${lines.join('\n')}\n\nOptions: ${globalOptions}`;
}
