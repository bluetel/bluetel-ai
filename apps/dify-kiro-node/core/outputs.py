"""Output variable shaping for Dify workflow nodes.

Builds the dict of variables declared in each tool's ``output_schema``
so downstream workflow nodes (e.g. a follow-up agent) can reference
``{{node.logs}}``, ``{{node.result_summary}}``, ``{{node.success}}``
etc. The same dict is also emitted as the node's ``json`` output.
"""

from typing import Any

from core.engines import EngineSpec


def artifact_value(task: dict[str, Any], artifact_type: str) -> str:
    """Returns the first artifact value of the given type, or ''."""
    for artifact in task.get('artifacts', []) or []:
        if isinstance(artifact, dict) and artifact.get('type') == artifact_type:
            return str(artifact.get('value', ''))
    return ''


def build_result_variables(
    task: dict[str, Any],
    engine: EngineSpec,
    warnings: list[str],
    logs_text: str = '',
    log_files: list[str] | None = None,
    elapsed_seconds: float | None = None,
    timed_out: bool = False,
) -> dict[str, Any]:
    """Builds the full result variable set for a finished (or timed-out) task."""
    status = str(task.get('status', 'unknown'))
    error_obj = task.get('error')

    if isinstance(error_obj, dict):
        error_text = f'[{error_obj.get("step", "unknown")}] {error_obj.get("message", "")}'
    elif timed_out:
        error_text = 'Timed out waiting for the worker task to complete'
    else:
        error_text = ''

    task_input = task.get('input') if isinstance(task.get('input'), dict) else {}

    variables: dict[str, Any] = {
        'task_id': str(task.get('id', '')),
        'status': status,
        'success': status == 'completed' and not timed_out,
        'timed_out': timed_out,
        'error': error_text,
        'prompt_summary': str(task.get('promptSummary') or ''),
        'result_summary': str(task.get('resultSummary') or ''),
        'stdout': artifact_value(task, 'stdout'),
        'has_changes': artifact_value(task, 'branch') != '',
        'engine': engine.name,
        'agent': str(task_input.get('agent', '')),
        'warnings': list(warnings),
        'logs': logs_text,
        'log_files': list(log_files or []),
    }
    if elapsed_seconds is not None:
        variables['elapsed_seconds'] = round(elapsed_seconds, 1)
    return variables


def build_error_variables(
    message: str,
    engine: EngineSpec,
    warnings: list[str] | None = None,
) -> dict[str, Any]:
    """Builds the same variable shape for failures before/around submission.

    Keeps every key present so downstream variable references never break
    when the worker is unreachable or rejects the task.
    """
    return {
        'task_id': '',
        'status': 'error',
        'success': False,
        'timed_out': False,
        'error': message,
        'prompt_summary': '',
        'result_summary': '',
        'stdout': '',
        'has_changes': False,
        'engine': engine.name,
        'agent': '',
        'warnings': list(warnings or []),
        'logs': '',
        'log_files': [],
    }


def build_summary_text(variables: dict[str, Any]) -> str:
    """Builds a short human-readable summary for the node's text output."""
    lines = [
        f'Task {variables.get("task_id") or "(not created)"} — status: {variables.get("status")}',
        f'Engine: {variables.get("engine")}'
        + (f' (agent: {variables["agent"]})' if variables.get('agent') else ''),
    ]
    if variables.get('result_summary'):
        lines.append(f'Result: {variables["result_summary"]}')
    if variables.get('has_changes'):
        lines.append('Changes were pushed to a remote branch.')
    if variables.get('error'):
        lines.append(f'Error: {variables["error"]}')
    for warning in variables.get('warnings', []):
        lines.append(f'Warning: {warning}')
    if variables.get('log_files'):
        lines.append(f'Session logs captured: {len(variables["log_files"])} file(s)')
    return '\n'.join(lines)
