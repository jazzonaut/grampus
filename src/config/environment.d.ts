// Environment variables that Grampus reads. Declaring them keeps `process.env.NAME` typed under
// `noPropertyAccessFromIndexSignature`; any other variable must use bracket access.
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /** Overrides the data directory (config.json and task folders). */
      GRAMPUS_HOME?: string;
      /** The Orca CLI executable. Orca sets it inside its own terminals. */
      ORCA_CLI_COMMAND?: string;
      /** The handle of the Orca terminal this process runs in. Orca sets it; the driver is that terminal's coordinator. */
      ORCA_TERMINAL_HANDLE?: string;
      /** Claude Code's configuration directory; its `projects` folder holds session transcripts. */
      CLAUDE_CONFIG_DIR?: string;
      /** Codex's home directory; its `sessions` folder holds rollouts and `skills` holds user skills. */
      CODEX_HOME?: string;
      /** Windows per-user application data root for the default data directory. */
      LOCALAPPDATA?: string;
      /** XDG state root for the default data directory on Linux. */
      XDG_STATE_HOME?: string;
      /** Windows system root, used to locate `taskkill`. */
      SystemRoot?: string;
      /** Set to `0` for Git child processes so they never prompt. */
      GIT_TERMINAL_PROMPT?: string;
    }
  }
}

export {};
