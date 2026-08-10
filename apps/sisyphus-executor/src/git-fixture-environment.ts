/* cspell:ignore reflog gpgsign — git's own names: `GIT_REFLOG_ACTION` and `commit.gpgsign`. */
import process from 'node:process'

/**
 * **Test support for every fixture in this application that builds a real git repository. Not
 * production code.**
 *
 * It lives in `src/` for the reason `packages/sisyphus-api/src/server/admin/test-database.ts` does:
 * that is where the code importing it lives, and where the type checker and the linter can see it.
 * It is exported from **no barrel** — `run/index.ts`, `session/index.ts`, `bootstrap/index.ts` and
 * `delivery/index.ts` all deliberately omit it — because a module whose job is to mutate the
 * process environment should not be one import away from the executor's own run path.
 *
 * Its importers are the six suites listed below, plus two fixture builders that are test support in
 * everything but their file names: `delivery/test-repository.ts`, which four delivery suites share,
 * and `session/spike-restore.ts`, the S2 harness whose only caller is its own test. **Nothing on
 * the executor's run path imports it**, which is the property that matters; the run path never
 * builds a repository, it is handed one.
 *
 * ## The failure this prevents
 *
 * `run/execute.test.ts`, `run/bootstrap.test.ts`, `session/snapshot.test.ts`,
 * `session/restore.test.ts`, `bootstrap/agent-start.test.ts` and `bootstrap/workspace.test.ts` each
 * build their fixture by shelling out to **real `git`** — through `bootstrap/run-command.ts` or
 * through `execFile` — and both of those spawn the child with `{ ...process.env, ...options.env }`.
 * That merge is the whole problem: it can add a variable and it can override one, and there is no
 * value it can supply that *removes* one. Whatever git-shaped configuration the caller's own
 * environment happens to hold is inherited, and the fixture is built under it.
 *
 * Ordinarily the caller's environment holds nothing of the kind and the suites pass. A **git hook**
 * is the case where it does. Git exports its own repository into every hook process it runs —
 * `GIT_DIR`, `GIT_INDEX_FILE`, and in a worktree a `GIT_DIR` pointing into `.git/worktrees/…` — so
 * a `git init` run from inside `.husky/pre-commit` does not initialise the temporary directory it
 * was given. It operates on **the repository the commit is being made in**. Observed rather than
 * theorised: 28 failures across four of these files under `pre-commit`, every one of them green
 * when the same suite was run by hand.
 *
 * A test that shells out to git and inherits the ambient repository is not a test of anything, and
 * the damage is not confined to the assertion it fails: `git init`, `git add` and `git commit`
 * against somebody's live index are writes to a repository nobody asked this suite to touch.
 *
 * ## Why the ambient variables are removed rather than overridden
 *
 * {@link stripAmbientGitEnvironment} deletes them from `process.env` itself, which is the only
 * place a deletion can happen given the merge above. It is safe to do because Vitest isolates each
 * test file in its own process — one file's strip cannot be observed by another — and it is
 * reversed by the returned callback so that a suite leaves the environment as it found it.
 *
 * The alternative, and the reason it was rejected: setting each variable to `''`. Git does not
 * treat an empty `GIT_DIR` as an absent one — it treats it as a repository path of zero length —
 * so the fixture would fail differently rather than correctly, and the failure would arrive as an
 * unreadable git error rather than as a test operating on the wrong repository. "Merging cannot
 * unset" is the fact this module is shaped around; papering over it with a sentinel value would
 * hide it.
 *
 * ## What is deliberately not in the strip list
 *
 * `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are **set** by
 * {@link GIT_FIXTURE_ENVIRONMENT} rather than stripped, because a fixture needs a definite identity
 * and a definite absence of user configuration — not merely the caller's absence of one. An
 * inherited `user.email` is not a correctness problem the way an inherited `GIT_DIR` is; an
 * inherited *lack* of one is, because `git commit` refuses without it on a machine that has never
 * been configured.
 */

/**
 * The variables git exports into a hook process, and every other variable that redirects a `git`
 * invocation at a repository the caller did not name.
 *
 * Taken from `githooks(5)` and `git(1)`'s environment section rather than from the two that were
 * observed to break, which is the difference between a fix and a patch: `GIT_DIR` and
 * `GIT_INDEX_FILE` are what a `pre-commit` hook happens to export today, and a `pre-receive` or a
 * `filter-branch` exports more. Each one is capable on its own of pointing a fixture's `git init`,
 * `git add` or `git commit` at the ambient repository:
 *
 * - `GIT_DIR` — the repository directory. The one that turns `git init /tmp/…` into a re-init of
 *   the caller's own repository, and the one a worktree points into `.git/worktrees/<name>`.
 * - `GIT_COMMON_DIR` — the shared half of a worktree's repository, where refs and objects live.
 * - `GIT_INDEX_FILE` — the staging area. `git add` in a fixture stages into the caller's commit.
 * - `GIT_WORK_TREE` — the tree those paths are taken relative to.
 * - `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES` — where objects are written and read.
 * - `GIT_PREFIX` — the subdirectory the outer command was run from, which relative paths resolve
 *   against.
 * - `GIT_REFLOG_ACTION` — harmless to the outcome, but it writes the *caller's* action into the
 *   fixture's reflog, which makes a debugging session about a failing fixture start with a lie.
 */
export const AMBIENT_GIT_VARIABLES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REFLOG_ACTION',
  'GIT_WORK_TREE',
] as const

/**
 * The identity and configuration every fixture repository is built with.
 *
 * Passed as the child's `env` — where merging is exactly the right semantics, because these are
 * values the fixture is *adding*. `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are pointed at
 * `/dev/null` so that a developer's `~/.gitconfig` cannot decide the fixture's initial branch name,
 * its default hooks, or whether `commit.gpgsign` makes every fixture commit wait for a passphrase.
 *
 * `GIT_TERMINAL_PROMPT` is `0` so a fixture that reaches for a credential fails immediately instead
 * of blocking the suite on a prompt nobody is at a terminal to answer.
 */
export const GIT_FIXTURE_ENVIRONMENT: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'Sisyphus Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Sisyphus Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}

/** Undo a strip. Returned by {@link stripAmbientGitEnvironment}; idempotent. */
export type RestoreAmbientGitEnvironment = () => void

/**
 * Remove every variable in {@link AMBIENT_GIT_VARIABLES} from an environment.
 *
 * @param env - The environment to strip. Defaults to `process.env`, which is the only one that
 *   matters in practice — a caller passing its own object is a test proving this does what it says.
 * @returns A callback restoring exactly what was removed, and nothing else. Variables that were
 *   already absent stay absent: reinstating them as `undefined` would put the key back with a
 *   string value of `'undefined'`, which is worse than the leak this module exists to stop.
 */
export const stripAmbientGitEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
): RestoreAmbientGitEnvironment => {
  const removed = new Map<string, string>()

  for (const variable of AMBIENT_GIT_VARIABLES) {
    const value = env[variable]

    if (value !== undefined) {
      removed.set(variable, value)
      // `Reflect.deleteProperty` rather than `delete env[variable]`: the key is computed, and the
      // repository forbids dynamic `delete` because it is usually a sign of an object being used as
      // a map. Here the object *is* the process environment and removal is the whole point.
      Reflect.deleteProperty(env, variable)
    }
  }

  return () => {
    for (const [variable, value] of removed) {
      env[variable] = value
    }

    removed.clear()
  }
}

/**
 * The environment a fixture's `git` child is spawned with: the caller's, minus anything pointing at
 * the caller's repository, plus a definite identity.
 *
 * For the callers that spawn through `execFile` rather than through `bootstrap/run-command.ts` and
 * therefore compose the child's environment themselves — where composing is strictly better than
 * stripping, because it leaves the surrounding process untouched. The ones that go through
 * `runCommand` pass {@link GIT_FIXTURE_ENVIRONMENT} instead and rely on
 * {@link stripAmbientGitEnvironment} having emptied `process.env` of the rest, because that merge
 * is not theirs to control.
 *
 * @param overrides - Anything this particular invocation needs on top, such as the `GIT_SSH_COMMAND`
 *   a clone-that-must-not-reach-the-network test substitutes.
 */
export const gitFixtureEnvironment = (
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => {
  const inherited: NodeJS.ProcessEnv = { ...process.env }

  for (const variable of AMBIENT_GIT_VARIABLES) {
    Reflect.deleteProperty(inherited, variable)
  }

  return { ...inherited, ...GIT_FIXTURE_ENVIRONMENT, ...overrides }
}
