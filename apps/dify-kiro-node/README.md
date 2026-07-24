# Dify Kiro Node (`kiro_delegator`)

A [Dify](https://dify.ai/) **tool plugin** that adds workflow nodes for delegating
coding tasks to an AWS Kiro sub-agent (or other engines) through the
[`kiro-github-worker`](../kiro-github-worker) ("Rocky") in this monorepo, and pipes
the worker's session logs back into the workflow for consumption by follow-up
nodes (e.g. a review agent).

Dify plugins run on the Dify plugin daemon, which only supports Python — hence
this app is Python 3.12 while the rest of the monorepo is TypeScript. The pure
logic lives in `core/` (stdlib only, fully unit tested); the thin Dify
integration layer lives in `tools/` and `provider/`.

## Tools provided

| Tool                                    | Behaviour                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Delegate Task** (`delegate_task`)     | Submit a task, poll until it finishes (or `timeout_minutes` elapses), fetch session logs, return everything.       |
| **Submit Task** (`submit_task`)         | Fire-and-forget submission; returns `task_id` immediately.                                                         |
| **Get Task Result** (`get_task_result`) | Fetch status + result summary + session logs for a `task_id`. Pair with Submit Task for async flows or loop nodes. |

## How it talks to the worker

The plugin uses the worker's **admin REST API** (not MCP), because it is the
only surface that exposes session logs:

- `POST /api/tasks` — create a task (same validation as `rocky_executeTask`)
- `GET /api/tasks/:id` — unified task status, artifacts, prompt/result summaries
- `GET /api/logs` + `GET /api/logs/:filename` — session log files, matched to the
  task via the `task-{taskId}` / `setup-task-{taskId}` filename context
- `GET /api/summary` — used to validate credentials

Authentication is `Authorization: Bearer <ADMIN_API_TOKEN>`; leave the token
credential empty if the worker runs without `ADMIN_API_TOKEN`.

## Output variables

`delegate_task` and `get_task_result` expose typed output variables (declared in
each tool's `output_schema`) that downstream nodes reference directly, e.g.:

- `{{node.logs}}` — combined session logs (prompt, setup, stdout/stderr), the
  payload for a follow-up agent
- `{{node.result_summary}}` / `{{node.prompt_summary}}` — worker LLM summaries
- `{{node.success}}`, `{{node.status}}`, `{{node.timed_out}}`, `{{node.error}}` —
  for IF/ELSE branching
- `{{node.has_changes}}` — whether the agent pushed commits
- `{{node.stdout}}`, `{{node.task_id}}`, `{{node.log_files}}`, `{{node.warnings}}`

The same payload is also emitted as the node's standard `json` output, plus a
human-readable `text` summary.

## Prompt construction

Mirrors the worker's section-based prompt builder: the task prompt, an optional
`context` section (hand-over from a previous workflow node), and optional
`acceptance_criteria` are joined into delimited sections (`core/prompt.py`). The
worker itself wraps every prompt in its ephemeral-environment role preamble and
commit/push closing reminder, so the plugin intentionally does not duplicate
those constraints.

## Engine, agent, and model selection

Node parameters:

- `engine` — select: `kiro` (default), `copilot`, or `claude`
- `agent` — Kiro CLI agent name (e.g. `spec-orchestrator`); forwarded for
  engines with agent support
- `model` — model identifier; forwarded for engines with model support

Engines are described by `EngineSpec` entries in `core/engines.py`. When a
parameter isn't supported by the selected engine it is dropped and reported in
the `warnings` output rather than failing the task. Note the worker currently
routes on `engine`/`agent`; `model` is forwarded in the task payload for
forward-compatibility and is ignored by worker versions that don't support it.

### Adding a new engine (e.g. Claude Code)

1. Add an `EngineSpec` + `register_engine` call in `core/engines.py`.
2. Add the matching `options` entry to the `engine` parameter in
   `tools/delegate_task.yaml` and `tools/submit_task.yaml`.
3. Implement the engine executor in `kiro-github-worker` (a new executor module
   plus a branch in its `executor-router`).

Nothing else changes — payload construction, polling, log retrieval, and output
shaping are engine-agnostic.

## Development

```bash
# Unit tests (stdlib only — no dependencies needed)
pnpm nx test dify-kiro-node

# Syntax check (used as the build target)
pnpm nx build dify-kiro-node
```

### Remote debugging against a Dify instance

```bash
cd apps/dify-kiro-node
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in host/port/key from Dify → Plugins → Debug Plugin
python -m main
```

The plugin appears live in your Dify workspace; code changes take effect on
restart of `python -m main`.

### Packaging

```bash
pnpm nx package dify-kiro-node   # runs `dify plugin package .` when the dify CLI is installed
```

Produces `kiro_delegator.difypkg`, installable via Dify → Plugins → Install via
Local File. The `dify` CLI ships with the
[dify-plugin-daemon releases](https://github.com/langgenius/dify-plugin-daemon/releases).

## Example workflow

1. **Start** → collect a feature request.
2. **Delegate Task** node → `repo_url`, `base_branch: main`, `prompt` from the
   request; engine `kiro`, agent `spec-orchestrator`, timeout 30 min.
3. **IF/ELSE** on `{{delegate.success}}`.
4. **Agent (follow-up)** node → reviews `{{delegate.logs}}` and
   `{{delegate.result_summary}}`, posts a review comment or triggers a retry
   with refined instructions via another Delegate Task node.
