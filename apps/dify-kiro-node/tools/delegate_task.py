"""Delegate Task tool — submit a task to the worker and wait for it.

The synchronous workhorse of this plugin: builds the prompt, submits the
task via the worker admin API, polls until the task reaches a terminal
status (or the timeout elapses), retrieves the session logs, and emits
the result as text, JSON, and typed output variables for downstream
workflow nodes.
"""

from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from core.client import WorkerApiError, WorkerClient
from core.engines import get_engine
from core.logs import collect_session_logs
from core.outputs import build_error_variables, build_result_variables, build_summary_text
from core.payload import build_task_payload
from core.poller import wait_for_terminal_status
from core.prompt import build_task_prompt

DEFAULT_TIMEOUT_MINUTES = 15
MAX_TIMEOUT_MINUTES = 110
POLL_INTERVAL_SECONDS = 5.0


def resolve_timeout_minutes(raw: Any) -> float:
    """Clamps the timeout parameter into [1, MAX_TIMEOUT_MINUTES]."""
    try:
        minutes = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_MINUTES
    return max(1.0, min(float(MAX_TIMEOUT_MINUTES), minutes))


class DelegateTaskTool(Tool):
    def _invoke(
        self, tool_parameters: dict[str, Any]
    ) -> Generator[ToolInvokeMessage, None, None]:
        engine = get_engine(str(tool_parameters.get('engine') or 'kiro'))

        prompt = build_task_prompt(
            str(tool_parameters.get('prompt') or ''),
            context=tool_parameters.get('context'),
            acceptance_criteria=tool_parameters.get('acceptance_criteria'),
        )
        payload, warnings = build_task_payload(
            repo_url=str(tool_parameters.get('repo_url') or '').strip(),
            base_branch=str(tool_parameters.get('base_branch') or '').strip(),
            prompt=prompt,
            engine=engine,
            agent=tool_parameters.get('agent'),
            model=tool_parameters.get('model'),
            install_script=tool_parameters.get('install_script'),
        )
        timeout_minutes = resolve_timeout_minutes(
            tool_parameters.get('timeout_minutes', DEFAULT_TIMEOUT_MINUTES)
        )

        client = create_worker_client(self.runtime.credentials)

        try:
            created = client.create_task(payload)
            task_id = str(created.get('id', ''))
            poll = wait_for_terminal_status(
                lambda: client.get_task(task_id),
                timeout_seconds=timeout_minutes * 60,
                poll_interval_seconds=POLL_INTERVAL_SECONDS,
            )
            logs_text, log_files = collect_session_logs(client, task_id)
            variables = build_result_variables(
                poll.task,
                engine,
                warnings,
                logs_text=logs_text,
                log_files=log_files,
                elapsed_seconds=poll.elapsed_seconds,
                timed_out=poll.timed_out,
            )
        except WorkerApiError as err:
            variables = build_error_variables(str(err), engine, warnings)

        yield self.create_text_message(build_summary_text(variables))
        yield self.create_json_message(variables)
        for name, value in variables.items():
            yield self.create_variable_message(name, value)


def create_worker_client(credentials: dict[str, Any]) -> WorkerClient:
    """Builds a WorkerClient from provider credentials."""
    return WorkerClient(
        str(credentials.get('worker_base_url') or ''),
        api_token=str(credentials.get('admin_api_token') or '') or None,
    )
