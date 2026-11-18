### Dodo Usage

- Dodo stores markdown docs. `https://dodo.andrewminghanjiang.com/d/deploy/mini-pc` = `dodo show deploy/mini-pc`
- Full reference: `dodo help --json`. Use `--env dev` for the local `pnpm dev` server; default is prod.

### Development Guidelines

- Keep code implementation simple
- Write minimal comments, docs, and unit tests. None wherever possible
- Keep docblocks under 12 lines long

### Commits

- Use conventional commits: `type(scope): summary`. Types: feat, fix, perf, refactor, docs, test, build, ci, chore, style, revert.
- `feat:` → minor, `feat!:` or a `BREAKING CHANGE:` footer → major, every other type → patch. Every merge to `main` releases and deploys.
- End the PR title with the task key when there is one: `fix(search): trim the query (DODO-3)`. hawk marks the task done after the deploy.
- Migrations must not break the live version (add, do not rename or drop). Deploys are blue/green.
- Changes reach `main` through PRs only. PRs are squash merged, so the PR title is the commit message and must follow the same format.
