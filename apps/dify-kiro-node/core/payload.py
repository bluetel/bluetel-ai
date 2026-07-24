"""Worker task payload construction.

Builds the JSON body for ``POST /api/tasks`` on the kiro-github-worker
admin API. Validation rules match the worker's ``parseTaskInput`` so
obvious mistakes fail fast in the Dify node instead of producing a 400
round-trip.
"""

import re

from core.engines import EngineSpec

GITHUB_REPO_URL_RE = re.compile(
    r'^https://github\.com/[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+?(?:\.git)?$'
)

GIT_REF_RE = re.compile(r'^[a-zA-Z0-9\-_/.]+$')


def _validate_required_fields(repo_url: str, base_branch: str, prompt: str) -> None:
    """Validates required fields, raising ``ValueError`` on the first problem."""
    if not repo_url or not GITHUB_REPO_URL_RE.match(repo_url):
        raise ValueError(
            'repo_url must match https://github.com/{owner}/{repo} (optional .git suffix)'
        )
    if not base_branch or not GIT_REF_RE.match(base_branch):
        raise ValueError(
            'base_branch is required and may only contain alphanumeric, -, _, /, . characters'
        )
    if not prompt or not prompt.strip():
        raise ValueError('prompt is required and must be a non-empty string')


def _apply_gated_param(
    payload: dict[str, object],
    warnings: list[str],
    engine: EngineSpec,
    *,
    param_name: str,
    payload_key: str,
    value: str | None,
    supported: bool,
) -> None:
    """Adds an engine-gated optional param to ``payload`` or records a warning.

    Blank/absent values are ignored. Supported values are trimmed and stored
    under ``payload_key``; unsupported values append a warning instead.
    """
    if value is None or not value.strip():
        return
    if supported:
        payload[payload_key] = value.strip()
    else:
        warnings.append(
            f'Parameter "{param_name}" is not supported by the {engine.label} engine and was ignored'
        )


def build_task_payload(
    repo_url: str,
    base_branch: str,
    prompt: str,
    engine: EngineSpec,
    agent: str | None = None,
    model: str | None = None,
    install_script: str | None = None,
) -> tuple[dict[str, object], list[str]]:
    """Builds the worker task payload and collects warnings.

    Returns ``(payload, warnings)``. Warnings describe parameters that
    were provided but dropped because the selected engine does not
    support them. Raises ``ValueError`` for invalid required fields.
    """
    _validate_required_fields(repo_url, base_branch, prompt)

    payload: dict[str, object] = {
        'repoUrl': repo_url,
        'baseBranch': base_branch,
        'prompt': prompt,
        'engine': engine.worker_engine,
    }
    warnings: list[str] = []

    _apply_gated_param(
        payload,
        warnings,
        engine,
        param_name='agent',
        payload_key='agent',
        value=agent,
        supported=engine.supports_agent,
    )
    _apply_gated_param(
        payload,
        warnings,
        engine,
        param_name='model',
        payload_key='model',
        value=model,
        supported=engine.supports_model,
    )

    if install_script is not None and install_script.strip():
        payload['installScript'] = install_script

    return payload, warnings
