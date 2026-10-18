# Install a local Windows snapshot

Double-click **Install-Grampus.cmd**, or run this from the checkout:

```powershell
npm run install:local
```

The interactive installer checks dependencies, asks for a destination and shows an
installation summary before confirmation. It requires Windows, Node.js 24+ with
`node:sqlite`, npm, Git, Windows PowerShell 5.1+, Codex CLI and Claude Code CLI.
Missing or unusable dependencies refuse installation before any installation files
or PATH changes. Install those tools separately; Grampus does not install them.
CLI checks use `--version`, with no model inference. Subscription authentication is
checked when using the providers; run `grampus doctor` after installing to inspect it.
Orca is optional and is checked separately with `grampus doctor --orca` in an Orca workspace.

Default destination: `%LOCALAPPDATA%\Programs\Grampus`. No administrator access is
needed. The installer adds its `bin` directory to your **user** PATH. Open a new
terminal afterward; an existing terminal or parent application may retain its old
environment until restarted. Then run:

```powershell
grampus                       # Open the dashboard
grampus --version             # Version, mode and installed build id
grampus version               # Also show source, commit, build time and locations
grampus version --json
grampus doctor
```

All existing CLI commands work after `grampus`, without `npm start --`. The command
preserves your current directory, so relative brief and repository paths still work.
Keep its terminal open while using the dashboard.

The installer copies the current source, including uncommitted and untracked source
files, into a new version directory. It installs dependencies from the lockfile
using [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/),
builds there, removes development dependencies, checks runtime imports and required
assets, then selects that version. It neither uses nor modifies the checkout's
`dist` or `node_modules`. Package downloads may use the npm registry or cache.
Each snapshot contains its own production dependencies, UI assets and Windows
helpers. It uses Node.js from PATH, so Node.js 24+ must remain installed.

## Develop alongside the installed app

| Launch | Task data by default on Windows | Dashboard port |
| --- | --- | --- |
| `grampus` | `%LOCALAPPDATA%\Grampus\installed\journal.sqlite` | 4317 |
| `npm run ui` or `Grampus-Dev.cmd` in the checkout | `%LOCALAPPDATA%\Grampus\development\<checkout-id>\journal.sqlite` | 4318 |

Each development checkout has its own data directory. Editing, building or testing
the checkout does not replace installed code. The explicitly named development
launcher also avoids shadowing installed `grampus` in Command Prompt. The dashboard footer identifies its
version, installed/development mode and installed build id. The installed command
and development command can run simultaneously.

`GRAMPUS_HOME` and `--db` remain explicit data overrides; using the same override
for both copies deliberately shares their journal. Use `--port` to override a
dashboard port, including when running multiple development checkouts. Provider
subscription credentials are still shared through the providers' existing logins.
Isolation does not prevent two tasks from targeting the same externally managed
repository or workspace; use separate task workspaces.

Earlier checkout versions used `%LOCALAPPDATA%\Grampus\journal.sqlite`. That journal
and its evidence are left in place. Inspect it explicitly with `--db` if needed;
the installer does not migrate, move or delete task history.

## Update explicitly

```powershell
grampus update
# If the source checkout moved, or to install a different checkout:
grampus update --source C:\Projects\Grampus
```

The command runs the installer from the recorded source checkout and shows the
current build and destination before asking for confirmation. Change the checkout
to the code you want first. Updates never fetch, pull, reset or commit source, and
never happen automatically. A build id, source digest, commit and local-change flag
distinguish snapshots even when their package version is the same.

An update installs into a fresh directory. Failed dependency checks, package
installation or builds leave the current version selected. Activation replaces one
small selection file after the snapshot checks pass. Each version keeps its final
directory name throughout copying, building and activation. This avoids the
parent-directory rename that a Windows file reader could block. Running processes retain their
original version and asset/worker paths; restart Grampus to use the new one. Stop
active work and close the old dashboard before starting the new version, especially
across future journal schema changes. Installed task data is preserved.

Older version directories are retained; no automatic cleanup or journal rollback
is provided. Reverting code does not undo a journal migration. An interrupted
installer may leave `install.lock`; inspect its recorded PID and remove the lock
only after that installer has exited, then rerun. This does not alter task recovery.
If Windows prevents cleanup after a failed build, the installer prints the retained
unselected directory and releases its installation lock. It preserves the selected
version and task data; retained unselected files do not become runnable through
`grampus`.

For scripts or a custom destination:

```powershell
npm run install:local -- --yes
npm run install:local -- --dir C:\Apps\Grampus --yes
# Skip PATH registration (also preserved by later updates):
npm run install:local -- --dir C:\Apps\Grampus --yes --no-path
grampus update --yes
```

The destination must be outside the checkout and either empty or an installation
owned by Grampus. Installation paths cannot contain semicolons, quotes, `%`, `!`
or newlines. Existing `GRAMPUS_CODEX_COMMAND` and `GRAMPUS_CLAUDE_COMMAND` overrides
are honored; each must name a native executable, not a shell command or npm batch shim.
The installer serializes updates to one destination and never overwrites arbitrary
existing directories. This distribution is for local Windows trials; downloading
published releases, a bundled Node runtime and macOS/Linux installers remain future work.
