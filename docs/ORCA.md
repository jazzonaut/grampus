# Orca desktop plugin

The plugin adds **Grampus: Open** and **Grampus: Stop Dashboard** to Orca's native
commands. Assign a shortcut to either command in Orca's shortcut settings. Daily use
needs no terminal, npm command or visible background window.

**Open** starts a local controller if none is running, or authenticates and reconnects
to the existing instance. It opens or focuses the dashboard in Orca's embedded browser.
The dashboard still handles planning, approval, questions, guidance and recovery.
Closing Orca or disabling the plugin does not stop Grampus or its task workers.

On **New task**, **Or choose an Orca worktree** lists Orca's local worktrees grouped by
repository, each with its full path; choosing one fills the repository folder. Orca's plugin
API does not tell a command which worktree is focused, so the dashboard cannot preselect it.

**Stop Dashboard** requests graceful shutdown. It refuses while a dashboard action is
running. Finish or stop that task through Grampus first, then use the command again.
Closing a dashboard never stops separately launched CLI controllers. Task files,
commits and the journal are retained.

## Installed application

Grampus install and update automatically build an Orca package at
`<installation directory>\orca-plugin` and print that location. With the default
Windows installation, select this folder in **Orca Settings → Plugins**:

```text
%LOCALAPPDATA%\Programs\Grampus\orca-plugin
```

Turn on Orca's experimental plugin system if prompted, install the local folder,
then review and enable **Grampus**. This is a one-time Orca setup; no separate
packaging command is needed. Orca remains optional during Grampus installation.

Updates refresh the package at the same path. Its installed entry reads Grampus's
atomic version selection on each command and loads the selected snapshot's worker,
even when Orca copied the package during installation. A failed build or package
publication keeps the previous selection. The plugin calls the stable installed
launcher, so no path to the development checkout is needed.

A running controller survives an update. Open reconnects to that instance until it
is explicitly closed; the next launch then uses the newly selected snapshot.
Development and installed packages retain separate data directories and ports.
The Grampus installer prepares the package; installation and enablement in Orca
still use Orca's supported UI.

## Development checkout

Run once after building or changing this integration:

```powershell
npm run build:orca-plugin
```

This builds Grampus and packages a local plugin at `.grampus/orca-plugin`. In Orca,
open **Settings → Plugins**, turn on the experimental plugin system, then install
the package using its local folder path. Review and enable **Grampus Development**.
Its commands are named **Grampus Development: Open** and **Grampus Development:
Stop Dashboard**, so they cannot be mistaken for an installed application.

The package pins the Node executable, Grampus launcher and Orca CLI used on this
machine. It is a local package, not a portable distribution. Rebuild it if those
locations change. The plugin uses no terminal input capability and never sends
messages to an implementation agent. Its Node worker launches Grampus's own `open`
and `close` commands without shell interpolation. On Windows it restores missing
`APPDATA` and `LOCALAPPDATA` values for those child processes by querying Windows
known folders through PowerShell. Orca deliberately strips these variables from
its plugin worker; its CLI needs `APPDATA` to find the running runtime. Existing
values are preserved, and redirected Windows profiles use their configured paths.

Orca's plugin system is experimental. The manifest and worker follow the public
[manifest contract](https://github.com/stablyai/orca/blob/main/src/shared/plugins/plugin-manifest.ts)
and [command example](https://github.com/stablyai/orca/blob/main/examples/plugins/hello-orca/main.mjs).
Installation and enablement happen through Orca's supported UI, never by editing
its metadata files. No plugin is published or automatically enabled by the builder.

## Launcher behaviour

`grampus open --orca` is the underlying start-or-reconnect command;
`grampus open --no-open` starts or checks the service without navigation, and
`grampus close` requests shutdown. `--db` and `--port` remain explicit overrides.
The foreground `grampus ui --orca` command remains useful for development diagnostics.

Each application and journal profile has a private receipt, startup mutex and log in
`<data directory>/desktop/`. The receipt contains a bearer access link and is local
credential material. Do not share it. Background logs omit that access link and are
replaced on a fresh start after the preceding process is proved gone.

Startup is serialised across launcher processes with a separate SQLite lock file.
It holds no workflow records. The launcher durably records the child's PID before
granting an IPC startup permit. An authenticated response must match the exact
instance, application and journal before a launch is reported ready. A live or
unverifiable process is never replaced just because its HTTP response is missing.
A provably exited owner permits a fresh start. Malformed or foreign receipts stop
discovery for inspection. A timeout leaves the process and its receipt in place;
reopening observes it again and never replays task, provider or Git operations.

`dashboardStartupMs`, `dashboardProbeMs` and `dashboardPollMs` tune startup and
observation ([CONFIGURATION.md](CONFIGURATION.md)). Card projection uses
`orcaSyncIntervalMs` while the dashboard runs ([DASHBOARD.md](DASHBOARD.md)).

**Planned:** a native task-summary panel and native Orca implementation and review
conversations. The current plugin reuses the full Grampus dashboard.
