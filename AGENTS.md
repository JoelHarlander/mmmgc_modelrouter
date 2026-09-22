# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Commands

`npm run check` (tsc) · `npm test` (node --test) · `npm run smoke` (pi on the faux provider) ·
`npm run eval` / `npm run eval:all -- --gate` (router eval). All four are offline and spend nothing.
Scripts and their exact invocations live in `package.json`.

## Layout

`src/` is the shipped pi extension; `eval/` is the measurement harness and imports from `src/` but is never
imported by it. `eval/README.md` explains what the harness declares versus measures — read it before trusting
any number it prints. `eval/results/log.md` opens with a findings index: every claim made about the router,
which round established it, and what it rests on.

## Sharp edges

- **A model switch is not the only thing that discards the prompt cache.** A thinking-level change does too, and
  `src/index.ts` re-applies `cfg.thinking[tier]` every turn — so a tier flip costs a full context re-write even
  when the model does not change. The eval reports this as `coldByCause: thinking-change`.
- **Subscription routes bill the ledger $0** while still consuming a plan, so `ledger.costUsd` is not the cost of
  a run. The eval reports `listEquivalentUsd` and `planHiddenUsd` beside it; on the default config the hidden
  half is ~98% of spend.
- **The default tiers are not a cost ladder.** `gpt-6-astra` (standard) costs more per token than
  `claude-opus-5` (heavy), so escalating a tier can make a turn cheaper. `npm run eval -- --validate` warns
  about this and several consequences trace back to it.
- **The eval's `goldTier` is derived, never hand-written** — it is the cheapest tier holding a model that meets
  the turn's `requiredSkill`. Editing a task pack means editing `requiredSkill`; `--validate` fails if a written
  `goldTier` disagrees.
- `test/eval.test.ts` pins several things against `src/` source text (the fan-out candidate policy, the judge
  question, the stakes-override threshold, the auto-adopt confidence bar). Changing those in `src/` will fail
  tests in `test/` — that is deliberate, so the harness cannot silently drift from what ships.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
