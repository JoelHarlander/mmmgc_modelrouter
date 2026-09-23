# Releasing

Two channels, one direction of travel. Feature branches merge into `dev`; `dev` is promoted to
`main` as a deliberate release. Nothing else lands on `main`.

| Channel | Branch | Version it carries | Who runs it |
| --- | --- | --- | --- |
| dev | `dev` | `X.Y.Z-dev` | maintainers and anyone who opted in with `pi install …@dev` |
| stable (prod) | `main` | `X.Y.Z`, tagged `vX.Y.Z` | everyone else, including every unqualified install |

`main` is the repository's default branch, so an install that names no ref follows it. That is the
reason promotion is the only way onto `main`: a merge there is immediately what those users run on
their next `pi update`.

## Versions

Semantic versioning, with both a `package.json` bump and a `vX.Y.Z` git tag on the promoted commit.
Both, because they answer different questions and neither covers the other:

- the **tag** names the release immutably on the forge, and is a ref `pi install
  git:github.com/JoelHarlander/mmmgc_modelrouter@v0.2.0` can pin to;
- the **`package.json` version** is the only one the running extension can read. pi fetches its
  clone with `--no-tags` for a channel install, so the tag is usually not present locally — `/router`
  and `/router update` report the version from `package.json` and the commit from `HEAD`.

What makes a change patch, minor or major here is what it does to a user's *configuration and
commands*, not how much code moved:

- **patch** — behaviour fixes that need nothing from the user: a routing or billing verdict
  corrected, a provider's headers read properly, docs, tests.
- **minor** — anything new that an existing setup keeps working without: a new config key with a
  default, a new command or subcommand, a new provider or evidence source, changed default tiers.
- **major** — anything that makes an existing `~/.pi/agent/modelrouter.json`, a project
  `.pi/modelrouter.json`, or the shared ledger wrong until the user acts: a config key removed or
  renamed, a policy default that spends where it previously refused, a command removed, or a
  `usage.json` change older versions cannot read (`readLedgerFile` upgrades older files, so a
  version it can still upgrade is not major).

Between releases, a dev build is identified by **its `-dev` version plus its commit** —
`0.3.0-dev at 1a2b3c4`, which is what `/router` prints. `X.Y.Z-dev` is not a promise that the next
release will be `X.Y.Z`; it is the cycle that is open. The promotion decides the real number, and
`scripts/promote.sh 0.2.1` stamps a patch release out of a `0.3.0-dev` cycle without complaint.

## Promote dev to main

```bash
scripts/promote.sh <version> [next-dev-version]   # e.g. scripts/promote.sh 0.2.0
```

Run it from a clean clone that has both branches. It does every local step and stops before the
push, printing the exact push commands, so the tag and the log can be read before any user sees
them. In order it:

1. refuses a dirty tree, a branch not level with its `origin/` counterpart, an existing `vX.Y.Z`
   tag, a `main` that is not an ancestor of `dev` (the promotion must be a fast-forward), and a
   `dev` that holds nothing new;
2. **runs the release gate on the dev commit**: `npm run check`, `npm test`, `npm run smoke`,
   `npm run smoke:billing`;
3. stamps `X.Y.Z` in `package.json` on `dev` and commits it as `release: vX.Y.Z`;
4. fast-forwards `main` to that commit and tags it `vX.Y.Z`;
5. bumps `dev` to the next `-dev` version and commits it as `start X.Y.Z-dev`.

Then, after reading it back:

```bash
git push origin main v0.2.0     # stable channel first: this is what unqualified installs get
git push origin dev
```

The same procedure by hand, if the script cannot be run:

```bash
git fetch --prune origin main dev
git switch dev && git merge --ff-only origin/dev
npm run check && npm test && npm run smoke && npm run smoke:billing
npm version 0.2.0 --no-git-tag-version --allow-same-version
git commit -am "release: v0.2.0"
git switch main && git merge --ff-only dev
git tag -a v0.2.0 -m "pi-modelrouter v0.2.0"
git switch dev
npm version 0.3.0-dev --no-git-tag-version --allow-same-version
git commit -am "start 0.3.0-dev"
git push origin main v0.2.0 && git push origin dev
```

### Where CI would gate

Step 2 is the gate, and it is written to move. When a workflow exists, it should run those four
commands on every pull request into `dev` and on `dev` itself, and a branch protection rule on
`main` should require that check; `scripts/promote.sh` then re-runs them locally as belt and
braces, or the step is dropped from the script. Nothing else in the procedure changes: the version
stamp, the fast-forward and the tag stay a maintainer's deliberate act. There is no workflow in
this repository today, and whether to add one is still open.

### If `main` needs a fix before `dev` is ready

Branch from `main`, open the PR against `main`, and promote it as its own patch release. Then
`git switch dev && git merge main` straight away, so `main` stays an ancestor of `dev` and the next
promotion is still a fast-forward.

## Bootstrapping (once)

`dev` does not exist until someone creates it. From a clone with `main` up to date:

```bash
git switch main && git pull
git tag -a v0.1.0 -m "pi-modelrouter v0.1.0" && git push origin v0.1.0   # name what main already is
git switch -c dev
npm version 0.2.0-dev --no-git-tag-version --allow-same-version
git commit -am "start 0.2.0-dev"
git push -u origin dev
```

After that `main` is `v0.1.0` and `dev` reports `0.2.0-dev` at runtime, and the first
`scripts/promote.sh` run has everything it checks for.
