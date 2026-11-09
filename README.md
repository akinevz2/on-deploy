# on-deploy

kine's dotfiles manager: it drives the doftiles Makefile deployment —
checks required binaries, resolves them through per-distro deploy
scripts, stows the packages, and manages the services.

Project page: [akinevz.com/on-deploy](https://akinevz.com/on-deploy)

## Install

The package's `bin` entry is a TypeScript source (`src/index.ts`).
Install and run it with bun:

```sh
bun install          # or: bun add on-deploy
bunx on-deploy       # runs src/index.ts through bun's runtime
```

> **Note:** use bun or bunx, not npx — npx does not handle the
> TypeScript `bin` sources correctly.

For a standalone binary (the form the dots deployment uses), build it
with bunli:

```sh
git clone https://github.com/akinevz2/on-deploy ./on-deploy
cd ./on-deploy
bun install
bun x bunli build    # -> dist/on-deploy
```

## The contract

`on-deploy` runs **inside the ~/dots checkout** — it walks up from the
cwd to the repo root (marked by the manifest files) and reads four
repo-level manifests:

- `stow.depends` — the stow package list
- `wm.depends` — the required binaries + the deploy target/session
- `system.depends` — the submodule manifest (each line: a package and
  its dots-relative checkout paths)
- `services.depends` — the systemd user-unit start order

## The golden rule

on-deploy carries **zero per-package code**: no hardcoded package
names, no hardcoded behaviors. It knows platforms (debian-wsl |
debian | archlinux) and performs generic operations. All per-package
special steps live in the package Makefiles
(`dots/<pkg>/.local/share/depends/<pkg>/Makefile`), which defer to
`on-deploy pkg` for platform package-manager work.

## How it runs in practice

- **`make bootstrap`** (dots Makefile) — submodules → build the
  on-deploy binary → the deploy chain.
- **`make update`** — fetch + fast-forward, submodule sync, the
  on-deploy binary rebuild (unconditional).
- **`make install`** — the requirement walk + the per-package rules
  (incremental; keeps the recorded config).

## Build

- bunli CLI (`bunli build` → standalone `dist/on-deploy` binary).
- No whiptail/newt anywhere — the interactive surfaces are
  @bunli/runtime prompts plus one TSX diff viewer.
- `bun test` covers the manifests, the deploy-script protocol and the
  platform composition against fixtures.

See `on-deploy --help` for the full verb list.

## Delegation chain

```
dots Makefile                bootstrap | install | services-* | status
  └─ on-deploy stow|unstow --only <pkgs>
  └─ on-deploy packages <rule>   group runner over the package Makefiles
  └─ on-deploy pkg <op> <name>   platform package manager
  └─ on-deploy configure         manifest edits + the folded apply
  └─ on-deploy services <action> services.depends runner
```
