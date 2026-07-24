"""Get Task Result tool — fetch status and session logs for a task.

Companion to Submit Task: given a task id, returns the current task
state plus the worker session logs so a follow-up agent node can act on
what the delegated coding agent did. Does not poll — call it after a
delay, in a loop node, or once the task is expected to be finished.
"""

from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from core.client import WorkerApiError
from core.engines import get_engine
from core.logs import collect_session_logs
from core.outputs import build_error_variables, build_result_variables, build_summary_text

from tools.delegate_task import create_worker_client


class GetTaskResultTool(Tool):
    def _invoke(
        self, tool_parameters: dict[str, Any]
    ) -> Generator[ToolInvokeMessage, None, None]:
        task_id = str(tool_parameters.get('task_id') or '').strip()
        include_logs = tool_parameters.get('include_logs', True)
        engine = get_engine(str(tool_parameters.get('engine') or 'kiro'))

        if not task_id:
            raise ValueError('task_id is required')

        client = create_worker_client(self.runtime.credentials)

        try:
            task = client.get_task(task_id)
            logs_text = ''
            log_files: list[str] = []
            if include_logs:
                logs_text, log_files = collect_session_logs(client, task_id)
            variables = build_result_variables(
                task,
                engine,
                warnings=[],
                logs_text=logs_text,
                log_files=log_files,
            )
        except WorkerApiError as err:
            variables = build_error_variables(str(err), engine)
            variables['task_id'] = task_id

        yield self.create_text_message(build_summary_text(variables))
        yield self.create_json_message(variables)
        for name, value in variables.items():
            yield self.create_variable_message(name, value)
