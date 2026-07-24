"""Submit Task tool — fire-and-forget task submission.

Submits a task to the worker and returns immediately with the task id.
Pair with the Get Task Result tool (e.g. inside a Dify loop node, or in
a later workflow run) to collect the outcome and session logs without
blocking the current node for the task's full duration.
"""

from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from core.client import WorkerApiError
from core.engines import get_engine
from core.payload import build_task_payload
from core.prompt import build_task_prompt

from tools.delegate_task import create_worker_client


class SubmitTaskTool(Tool):
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

        client = create_worker_client(self.runtime.credentials)

        try:
            created = client.create_task(payload)
            variables: dict[str, Any] = {
                'task_id': str(created.get('id', '')),
                'status': str(created.get('status', 'submitted')),
                'success': True,
                'error': '',
                'engine': engine.name,
                'warnings': warnings,
            }
            text = f'Task {variables["task_id"]} submitted (status: {variables["status"]})'
        except WorkerApiError as err:
            variables = {
                'task_id': '',
                'status': 'error',
                'success': False,
                'error': str(err),
                'engine': engine.name,
                'warnings': warnings,
            }
            text = f'Task submission failed: {err}'

        yield self.create_text_message(text)
        yield self.create_json_message(variables)
        for name, value in variables.items():
            yield self.create_variable_message(name, value)
