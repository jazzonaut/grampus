// Environment variables that Grampus reads or sets for its own child processes. Declaring them keeps
// `process.env.NAME` typed under `noPropertyAccessFromIndexSignature`; any other variable must use
// bracket access, which marks it as an undeclared, dynamic name.
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /** Overrides the data directory (journal, settings and check logs). */
      GRAMPUS_HOME?: string;
      /** Searched for the native `codex`, `git` and Orca executables (case-insensitive on Windows). */
      PATH?: string;
      /** Overrides the Codex executable used for `codex app-server` and by `doctor`. */
      GRAMPUS_CODEX_COMMAND?: string;
      /** Overrides the Claude executable instead of the one bundled with the pinned Agent SDK. */
      GRAMPUS_CLAUDE_COMMAND?: string;
      /** Overrides the Orca CLI executable. */
      ORCA_CLI_COMMAND?: string;
      /** Selects the `orca-dev` CLI for an Orca development checkout. */
      ORCA_DEV_REPO_ROOT?: string;
      /** Remote Orca pairing; its presence makes the probes refuse Orca mode. */
      ORCA_PAIRING_CODE?: string;
      /** Remote Orca environment; its presence makes the probes refuse Orca mode. */
      ORCA_ENVIRONMENT?: string;
      /** Claude configuration directory, read for MCP carry-over. */
      CLAUDE_CONFIG_DIR?: string;
      /** An API key source that the Claude adapter refuses in favour of a first-party subscription. */
      ANTHROPIC_API_KEY?: string;
      /** Windows per-user application data root for the default data directory. */
      LOCALAPPDATA?: string;
      /** XDG state root for the default data directory on Linux. */
      XDG_STATE_HOME?: string;
      /** Windows system root for locating PowerShell. */
      SystemRoot?: string;
      /** Fallback Windows system root. */
      WINDIR?: string;
      /** Set to `0` for Git child processes so they never prompt. */
      GIT_TERMINAL_PROMPT?: string;
      /** Set to `1` for delivery Git so replace refs cannot alter what is verified. */
      GIT_NO_REPLACE_OBJECTS?: string;
    }
  }
}

export {};
