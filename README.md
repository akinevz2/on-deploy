# on-deploy

Rigorous deployment for the **doftiles** dotfiles (`github.com/akinevz2/doftiles`).
Three verbs, run in order on a fresh machine — or one call, `make bootstrap`.

```
on-deploy check        is each required binary installed?  (report)
on-deploy search       which package provides it?          (read-only)
on-deploy install      install the missing from the repos
on-deploy pkg          generic ops on GIVEN names:
                       pkg installed|search|install|remove <name>...
on-deploy configure    configure the deployment: target, binaries,
                       deployment model, git credentials — and APPLY
                       it (the folded apply: env, wsl verify, units;
                       credentials are PROMPTED for when absent)
on-deploy packages     group ops on the package Makefiles:
                       packages <rule> [pkg...]
on-deploy archive      back up a package's live files to defaults/
on-deploy unarchive    restore them
on-deploy preserve     resolve stow conflicts before (re)stowing:
                       bunli-native TUI — package checklist -> per-file
                       decisions with side-by-side/inline diff; the
                       archive-first keep flow is the non-tty fallback
on-deploy services     run the services.required units:
                       check|start|stop|restart|status

(no `apply` — folded into `configure`; no `toolchain` / `deps` —
installing components moved to the depends stow package:
depends/.local/bin/components via its package Makefile.)
```
```

## The golden rule

on-deploy carries **zero per-package code**: no hardcoded package
names, no behaviors associated to specific packages. It knows
platforms (debian-wsl | debian | archlinux) and performs generic
operations on the names it is GIVEN. All per-package special steps
(what to install for a feature, which service to restart, which files
to patch) live in the package Makefiles
(`dots/<pkg>/.local/share/<pkg>/Makefile`, bash), which defer to
`on-deploy pkg` for the platform package-manager work.

## The contract

`on-deploy` runs **inside the ~/dots checkout or any subdirectory of
it** (the cwd check walks up to the `wm.required` marker — package
dependency Makefiles `make -C dots/<pkg>/.local/share/<pkg>` and still
call it). git must agree the origin is `akinevz2/doftiles`. It reads
two repo-level manifests:

- **`stows.required`** — the stow-package manifest (one line per
  package; `#` comments and blanks ignored). The configuring scope for
  the stow walks.

- **`wm.required`** — line 1: the required binaries, whitespace-
  separated. Last non-comment line: the **deploy target** platform
  name (`ubuntu`, `manjaro`, …). That name selects the deploy script:
  `~/.local/bin/install/<target>.deploy`, whose contract is
  - `<target>.deploy <binary>` → prints the providing package
  - `<target>.deploy install <binary>` → prints the install COMMAND
    (which on-deploy then EXECUTES — sudo prompts pass through)

- **`wm.required`** (continued) — the optional `session = <model>`
  line sets the DEPLOYMENT MODEL (default `wsl-systemd`):
  `wsl-systemd` is the WSL bypass — NO display manager; hlwm runs as
  the systemd **user** unit and apply only VERIFIES the external X
  server. Package groups (xserver/nested/xrdp/greeter) are package
  Makefile rules, not manifest entries.

## The verbs

### `check` — is each required binary installed? (report, exit 1 on missing)

```
$ on-deploy check
target: ubuntu (wm.required)
  herbstluftwm         installed
  hsetroot             MISSING (package: hsetroot)
```

`--json` for machines (the same data, structured).

### `search` — which package provides it? (read-only)

Resolves through the `<target>.deploy` protocol (apt file lists /
pacman -Fs — platform scripts). `--only a,b` subsets; installed
binaries are skipped unless `--all`.

### `install` — install the missing from the repositories

Per binary: resolve the package, show the install command, confirm
(`[Y/n]`, Enter = yes), run it, then **re-verify** — a binary still
absent after its command ran is a hard failure for the run.

- `--yes` / `-y` — non-interactive
- `--dry-run` — resolve + print, run nothing
- `--only a,b` — subset

### `pkg` — generic operations on GIVEN names

```
on-deploy pkg installed <name>...   # exit 0 when all installed
on-deploy pkg search <name>...      # resolve providing package
on-deploy pkg install <name>...     # platform package manager
on-deploy pkg remove <name>...      # platform package manager
```

The ONLY place on-deploy touches a package manager; the names come
entirely from the caller (the package Makefiles). Platform resolution
(apt vs pacman) is the per-platform code — the ONLY per-platform code.

### `configure` — configure the deployment (TUI or flags)

The three manifests the verb edits:

- **`stows.required`** — the stow-package manifest (one package per
  line; `#` comments ignored). The scope of the stow walks and the
  config shipped by `make wm` / `packages` sweeps.
- **`wm.required`** — line 1 the required binaries (whitespace-
  separated), line 2 the optional deployment session (`wsl-systemd`),
  LAST non-comment line the deploy target (`ubuntu`, `manjaro`, …).
- **`system.required`** — each non-comment line: a stow package plus
  its dots-relative submodule path(s). THE CONFIGURED SUBMODULE SCOPE:
  `on-deploy depends` syncs/builds/installs exactly the packages it
  lists (intersected with .Makefile presence); the bare run is the
  discovery report from here.
- deployment model: session/features/units profile (the wm.required
  session line)
- git credentials — stored in `dots/shell/.my-credentials`
  (gitignored, stowed to ~/.my-credentials), NOT in the user's
  profile; when the file is ABSENT (fresh machine) and no flags were
  given, two simple lines are PROMPTED for (name, then email) and
  written so the stowed shell rc files autoload the git identity.
  Flag edits (`--name --email`) still work; validation accepts but
  warns.

Flags: `--target --add --remove --session --features --units --name
--email --show --dry-run`. Bare: the numbered TUI (a TTY). Bare +
non-TTY: prompts skipped, configuration saved with defaults.

Configuration FOLDS the apply: every save ends by running the
deployment model's generic step list (see below) and prints
`configure: saved + applied`.

### The folded apply (inside configure)

Resolves the platform (debian-wsl | debian | archlinux) and runs its
GENERIC step list: `env` (write ~/.config/doftiles/env) -> WSL-only
`vcxsrv` + `wsl-session` verify -> `units` (enable the profile's
units). NO package groups here: those are package Makefile rules
(`xserver`, `xinitrc`, `nested`, `xrdp`, `greeter` in the
herbstluftwm package Makefile) — run via `on-deploy packages <rule>`.
`--dry-run` prints what the apply would run and saves nothing.
`--show` prints the current configuration and runs nothing.

### `packages` — group operations on the package Makefiles

```
on-deploy packages <rule> [pkg...]   # a rule on some packages
on-deploy packages <rule>            # on EVERY package with a Makefile
on-deploy packages list              # which packages have one
```

Standard rules: install start stop uninstall status disable enable
(plus feature rules like xserver/nested/xrdp as the Makefiles define).

### `archive` / `unarchive` — the overwrites guard

`on-deploy archive <pkg>` copies the package's not-dots-owned $HOME
files into `~/dots/defaults/` BEFORE an install would overwrite them;
`on-deploy unarchive <pkg>` restores them (never clobbering a
dots-owned path). The package Makefiles call these from their
install/uninstall rules when the package touches pre-existing user
files.

### `preserve` — safe stow on a machine with pre-existing user files

`on-deploy preserve <pkg> [pkg2 ...]` (or `--only a,b`) resolves stow
conflicts so a fresh machine can stow without clobbering (or failing
on) pre-existing user files:

- **The resolver UI (bare/`--only` on a TTY)**: a bunli-native
  (opentui) checklist of the packages that HAVE conflicts, then per
  package each conflicting file gets its own decision prompt:
  - *view side-by-side diff* — full-screen `src/lib/diffview.tsx`
    TSX component (`diff -y` halves, `d` toggles inline unified diff,
    `q` closes)
  - *view inline diff* — unified `git diff --no-index` in the
    scrollback
  - *keep the dots version* — user bytes go to the XDG store
    (`preserve/<pkg>/`), the deployed file becomes the repo copy
  - *adopt MY version* — copied into the package tree; committing
    the adoption stays a manual step (manifest records both
    decisions, mode `mixed`)
  - cancel skips the file and the rest of the package
- **Default (archive-first, "dots wins")** — the branch any
  non-interactive run, `--yes`, and the Makefile fallback take:
  conflicts are copied into `~/.local/state/doftiles/preserve/<pkg>/`
  (XDG state, outside the repo — user content never lands in the
  worktree), removed from `$HOME`, then `stow -R` deploys the dots
  version. All-or-nothing: NOTHING is removed until every copy
  succeeded. On a TTY a post-stow prompt offers restore-or-keep
  (default keep); non-TTY defaults to keep without blocking.
- **`--adopt` ("mine wins", whole package)**: `stow -R --adopt` moves
  $HOME contents into the package tree (deployed = the user's bytes)
  and reports `git diff` for review. A snapshot of the adopted
  content is kept in the store as insurance; revert is
  `git checkout HEAD -- <pkg>`. A dirty worktree aborts the package
  (a clean `HEAD` is the restore point) — exit 2.
- `--dry-run` prints the plan; `--yes/-y` skips the prompts;
  `--keep` / `--restore` select the branch explicitly; `--store
  <dir>` overrides the store root.

`preserve` and `archive`/`unarchive` are complementary: `archive`
backs up for *uninstall-time* restore into `$HOME`; `preserve`
answers "first deployment on a dirty machine" and its restore writes
into the *package tree* (the dots-owned side), which `unarchive`
deliberately refuses to touch.

### `services` — run the services.required units

```
on-deploy services check      daemon-reload + enable --now each unit
on-deploy services start      daemon-reload + start each unit
on-deploy services stop       drop .wants links (never `disable` — a
                              stow-linked unit file would be DELETED),
                              cancel pending start/restart jobs, stop
on-deploy services restart    daemon-reload + restart each unit
on-deploy services status     report is-active per unit
```

All unit actions run `--no-block` (a headless herbst polls 30s for X
per attempt and would idle the caller). start/stop/restart confirm on
a TTY; non-interactive runs REQUIRE `--yes`. The unit list comes
entirely from the repo-level `services.required` manifest — no package
knowledge here.

### `toolchain` / `deps` — REMOVED (moved to the depends package)

Installing components is a package concern. The bun toolchain, bun
postinstall trust, the herbctl build and the polyframes deploy
(source | npm | release, method recorded in ~/.config/doftiles.conf)
now live in `depends/.local/bin/components` (stowed to
`~/.local/bin/components`), reached through the depends package
Makefile: `make -C depends/.local/share/depends install`, which
`on-deploy packages install` runs like any other package.

## How it runs in practice

- **`make bootstrap`** (dots Makefile) = submodules → build the
  on-deploy binary → `configure` → `install` (the requirement walk)
  → `stow` → `packages install` (components included) → `services
  check` → status.
- **`make install`** (dots Makefile) = the same sequence minus
  submodules/configure (incremental: keeps the recorded config).
- **`~/.local/bin/on.deploy`** is a shim to this binary — the Makefile
  target name is historic.

## Project shape

- bunli CLI (`bunli build` → standalone `dist/on-deploy` binary)
- NO whiptail/newt dependency anywhere — the interactive surfaces are
  @bunli/runtime prompts (select/multiselect/confirm/text/note,
  rendered through opentui) plus one TSX component (`src/lib/
  diffview.tsx`, the side-by-side diff viewer; tsconfig sets
  react-jsx + @opentui/react as the JSX import source)
- `src/lib/dots.ts` — the environment + manifest contract (cwd
  walk-up to the repo root, origin check, system.required parsing)
- `src/lib/deployScript.ts` — the `<target>.deploy` protocol
- `src/lib/platforms.ts` — platform resolution (debian-wsl | debian |
  archlinux) + generic step composition; apply DELEGATES to it
- `src/lib/provisioners.ts` — the GENERIC platform operations (env,
  wsl verify, units, VcXsrv) + the platform package-manager calls used
  by `pkg` (no package names)
- `tests/` — bun test suite (`bun test`)

## Delegation chain

```
dots Makefile                  bootstrap | install/stow | services-* |
                               status — short on-deploy sequences
  └─ on-deploy stow|unstow --only <pkgs>
  └─ on-deploy packages <rule> — the group runner over the package
       Makefiles (dots/<pkg>/.../Makefile):
       └─ depends/.local/bin/components   install the components
          (bun, trust, herbctl, polyframes) — the only package with
          its own binary installer, reached through its Makefile
       └─ on-deploy pkg <op> <name>...   (platform package manager)
       └─ on-deploy archive|unarchive <pkg>  (overwrites guard)
       └─ on-deploy preserve <pkg>          (conflict-safe stow)
  └─ on-deploy configure — the manifest edits + the folded apply
  └─ on-deploy services <action> — the services.required runner
```

Binary dependency management ALWAYS flows through on-deploy; the
package Makefiles own the special steps, the platform layer picks the
implementation, nothing in on-deploy knows a package name.
