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
                       deployment model, services, git credentials
on-deploy apply        apply the deployment model to the platform
                       (generic steps: env, wsl verify, units)
on-deploy packages     group ops on the package Makefiles:
                       packages <rule> [pkg...]
on-deploy archive      back up a package's live files to defaults/
on-deploy unarchive    restore them
on-deploy toolchain    bootstrap assurances (bun, trust, herbctl)
on-deploy deps         dependency deployment (polyframes)
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

## The contract

`on-deploy` runs **inside the ~/dots checkout or any subdirectory of
it** (the cwd check walks up to the `wm.requires` marker — package
dependency Makefiles `make -C dots/<pkg>/.local/share/<pkg>` and still
call it). git must agree the origin is `akinevz2/doftiles`. It reads
two repo-level manifests:

- **`wm.requires`** — line 1: the required binaries, whitespace-
  separated. Last non-comment line: the **deploy target** platform
  name (`ubuntu`, `manjaro`, …). That name selects the deploy script:
  `~/.local/bin/install/<target>.deploy`, whose contract is
  - `<target>.deploy <binary>` → prints the providing package
  - `<target>.deploy install <binary>` → prints the install COMMAND
    (which on-deploy then EXECUTES — sudo prompts pass through)

- **`wm.requires`** (continued) — the optional `session = <model>`
  line sets the DEPLOYMENT MODEL (default `wsl-systemd`):
  `wsl-systemd` is the WSL bypass — NO display manager; hlwm runs as
  the systemd **user** unit and apply only VERIFIES the external X
  server. Package groups (xserver/nested/xrdp/greeter) are package
  Makefile rules, not manifest entries.

## The verbs

### `check` — is each required binary installed? (report, exit 1 on missing)

```
$ on-deploy check
target: ubuntu (wm.requires)
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

- deploy target + required binaries (`wm.requires`)
- deployment model: session + features + services/units
  (the wm.requires session line)
- git credentials — stored in `dots/shell/.my-credentials`
  (gitignored, stowed to ~/.my-credentials), NOT in the user's
  profile; writes the file, regenerates `~/.my-credentials-env`,
  applies git config

Flags: `--target --add --remove --session --features --units --name
--email --show`. Bare: the numbered TUI.

### `apply` — apply the deployment model to the platform

Resolves the platform (debian-wsl | debian | archlinux) and runs its
GENERIC step list: `env` (write ~/.config/doftiles/env) -> WSL-only
`vcxsrv` + `wsl-session` verify -> `units` (enable the profile's
units). NO package groups here: those are package Makefile rules
(`xserver`, `xinitrc`, `nested`, `xrdp`, `greeter` in the
herbstluftwm package Makefile) — run via `on-deploy packages <rule>`.
Configuration is the configure wizard (`on-deploy configure`).

- `--dry-run` — print the steps
- `--profile <name>` — read a different profile file from ~/dots

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

### `toolchain` / `deps` — the artifact assurances

bun toolchain + postinstall trust + herbctl build (`toolchain`);
polyframes artifact per the recorded method (`deps`,
`--method source|npm|release`, `--uninstall`).

## How it runs in practice

- **`make bootstrap`** (dots Makefile) = submodules -> stow ->
  polyframes deploy -> `on-deploy` (the bare invocation = check +
  interactive install walk) -> systemd enable + status.
- **`make install`** (dots Makefile) = stow everything + run each
  package's dependency Makefile (install rule).
- **`~/.local/bin/on.deploy`** is a shim to this binary — the Makefile
  target name is historic.
- `make provision` — runs `on-deploy apply` (see the dots Makefile).

## Project shape

- bunli CLI (`bunli build` → standalone `dist/on-deploy` binary)
- `src/lib/dots.ts` — the environment + manifest contract (cwd
  walk-up to the repo root, origin check, wm.requires parsing)
- `src/lib/deployScript.ts` — the `<target>.deploy` protocol
- `src/lib/platforms.ts` — platform resolution (debian-wsl | debian |
  archlinux) + generic step composition; apply DELEGATES to it
- `src/lib/provisioners.ts` — the GENERIC platform operations (env,
  wsl verify, units, VcXsrv) + the platform package-manager calls used
  by `pkg` (no package names)
- `tests/` — bun test suite (`bun test`)

## Delegation chain

```
dots Makefile (install)
  └─ dots/<pkg>/.local/share/<pkg>/Makefile   standard rules +
       feature rules (bash — the special steps: what to install for a
       feature, which service to restart, what to patch)
       └─ on-deploy pkg <op> <name>...   (platform package manager)
       └─ on-deploy toolchain | deps     (artifact assurances)
       └─ on-deploy archive|unarchive <pkg>  (overwrites guard)
on-deploy packages <rule>  — the group runner over those Makefiles
on-deploy apply            — the generic platform steps (env, verify,
                             units) per the deployment model
```

Binary dependency management ALWAYS flows through on-deploy; the
package Makefiles own the special steps, the platform layer picks the
implementation, nothing in on-deploy knows a package name.
