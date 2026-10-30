# on-deploy

Rigorous deployment for the **doftiles** dotfiles (`github.com/akinevz2/doftiles`).
Three verbs, run in order on a fresh machine — or one call, `make bootstrap`.

```
on-deploy check        what's missing?            (report only)
on-deploy deploy       install the missing        (interactive | --yes)
on-deploy provision    platform services setup    (per deploy.profile)
```

## The contract

`on-deploy` runs **inside the ~/dots checkout** (git must agree the
origin is `akinevz2/doftiles`) and reads two repo-level manifests:

- **`wm.requires`** — line 1: the required binaries, whitespace-
  separated. Last non-comment line: the **deploy target** platform
  name (`ubuntu`, `manjaro`, …). That name selects the deploy script:
  `~/.local/bin/install/<target>.deploy`, whose contract is
  - `<target>.deploy <binary>` → prints the providing package
  - `<target>.deploy install <binary>` → prints the install COMMAND
    (which on-deploy then EXECUTES — sudo prompts pass through)

- **`deploy.profile`** — the platform-provisioning manifest:
  ```ini
  session = greetd | wsl-systemd   # how the graphical session starts
  xserver      # X server + xinit packages
  xinitrc      # ~/.xinitrc execs herbstluftwm
  greeter      # greetd + tuigreet + the xsessions entry
  ```
  `session = wsl-systemd` (the WSL bypass): NO display manager is
  installed — herbstluftwm runs as the systemd **user** unit
  `herbst.service`, which waits for the Windows-side X server
  (VcXsrv, `localhost:0.0`). Provision then only VERIFIES: unit
  enabled/active + X reachable. A `greeter` feature contradicts a
  `wsl-systemd` session — that's an error. No profile file (or an
  empty one) = nothing to provision.

## The verbs

### `check` — report only, exit 1 when anything is missing

```
$ on-deploy check
deploy target: ubuntu
  herbstluftwm         installed
  hsetroot             MISSING (package: hsetroot)
```

`--json` for machines (the same data, structured).

### `deploy` — install every missing required binary

Per binary: resolve the package, show the install command, confirm
(`[Y/n]`, Enter = yes), run it, then **re-verify** — a binary still
absent after its command ran is a hard failure for the whole run
(exit 1, with the report).

- `--yes` / `-y` — non-interactive: no confirmations. A failed install
  still fails the run (bootstrap scripts can detect it).
- `--dry-run` — resolve + print what would run; nothing is executed.

### `provision` — platform services per `deploy.profile`

- `xserver` — apt/pacman installs the startx-capable set (target-
  specific package lists; ubuntu: `xserver-xorg`, `xinit`, `xauth`; …)
- `xinitrc` — create `~/.xinitrc` with `exec herbstluftwm`; if one
  already exists, other `exec` lines are commented out (xinit runs
  only the first) and ours appended — idempotent, never destructive
- `greeter` — the session entry
  `/usr/share/xsessions/herbstluftwm.desktop`, greetd + tuigreet
  (ubuntu: greetd from apt + tuigreet built via `cargo install
  --root /usr/local`, since the greeter user can't see `~/.cargo`),
  `/etc/greetd/config.toml` written (existing file backed up to
  `.bak`), `systemctl enable greetd`
- `session = wsl-systemd` — the verify-only branch described above

Every step is idempotent (already-done → `ok` without changes) and
reports `ok/FAILED — detail` per feature; any failure fails the run.

- `--yes` — no confirmations
- `--dry-run` — print the steps
- `--profile <name>` — read a different profile file from ~/dots

## How it runs in practice

- **`make bootstrap`** (dots Makefile) = submodules → stow →
  polyframes deploy → `on-deploy` (the bare invocation = check +
  interactive deploy walk) → systemd enable + status.
- **`~/.local/bin/on.deploy`** is a shim to this binary — the Makefile
  target name is historic.
- `make provision` — runs `on-deploy provision` (see the dots
  Makefile).

## Project shape

- bunli CLI (`bunli build` → standalone `dist/on-deploy` binary)
- `src/lib/dots.ts` — the environment + manifest contract
- `src/lib/deployScript.ts` — the `<target>.deploy` protocol
- `src/lib/profile.ts` — `deploy.profile` parsing (features + session model)
- `src/lib/provisioners.ts` — the idempotent provisioning steps
- `tests/` — bun test suite
