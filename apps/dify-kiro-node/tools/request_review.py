"""Request Review tool — pause a workflow for human approval.

The human-in-the-loop workhorse of this plugin. Because Dify's native
Human Input node cannot run inside a Loop node, this tool achieves the
same pause/resume behaviour as a *synchronous Tool*: it creates a review
request on the worker, blocks while polling until a human approves or
rejects it (or the timeout elapses), and emits the decision as typed
output variables so a downstream IF/ELSE node can route the loop.

The reviewer actions the request in the admin dashboard's Reviews page.
"""

from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from core.poller import wait_for_terminal_status
from core.review_client import ReviewApiError, ReviewClient
from core.review_outputs import (
    REVIEW_TERMINAL_STATUSES,
    build_error_review_variables,
    build_review_summary,
    build_review_variables,
)

DEFAULT_TIMEOUT_MINUTES = 60
MAX_TIMEOUT_MINUTES = 240  # 4 hours — bounded by main.py MAX_REQUEST_TIMEOUT
POLL_INTERVAL_SECONDS = 15.0


def resolve_timeout_minutes(raw: Any) -> float:
    """Clamps the timeout parameter into [1, MAX_TIMEOUT_MINUTES]."""
    try:
        minutes = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_MINUTES
    return max(1.0, min(float(MAX_TIMEOUT_MINUTES), minutes))


def parse_iteration(raw: Any) -> int | None:
    """Coerces the iteration parameter to a non-negative int, or None."""
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


class RequestReviewTool(Tool):
    def _invoke(
        self, tool_parameters: dict[str, Any]
    ) -> Generator[ToolInvokeMessage, None, None]:
        title = str(tool_parameters.get('title') or '').strip()
        content = str(tool_parameters.get('content') or '').strip()

        if not title or not content:
            variables = build_error_review_variables('title and content are required')
            yield from self._emit(variables)
            return

        timeout_minutes = resolve_timeout_minutes(
            tool_parameters.get('timeout_minutes', DEFAULT_TIMEOUT_MINUTES)
        )
        payload: dict[str, Any] = {
            'title': title,
            'content': content,
            'ttlSeconds': int(timeout_minutes * 60),
        }
        for key, param in (
            ('context', 'context'),
            ('repoFullName', 'repository'),
            ('branch', 'branch'),
        ):
            value = str(tool_parameters.get(param) or '').strip()
            if value:
                payload[key] = value
        iteration = parse_iteration(tool_parameters.get('iteration'))
        if iteration is not None:
            payload['iteration'] = iteration

        credentials = self.runtime.credentials
        review_app_url = str(credentials.get('review_app_url') or '')

        try:
            client = create_review_client(credentials)
            created = client.create_review(payload)
            review_id = str(created.get('id', ''))
            poll = wait_for_terminal_status(
                lambda: client.get_review(review_id),
                timeout_seconds=timeout_minutes * 60,
                poll_interval_seconds=POLL_INTERVAL_SECONDS,
                terminal_statuses=REVIEW_TERMINAL_STATUSES,
            )
            variables = build_review_variables(
                poll.task,
                timed_out=poll.timed_out,
                elapsed_seconds=poll.elapsed_seconds,
                review_app_url=review_app_url,
            )
        except ReviewApiError as err:
            variables = build_error_review_variables(str(err))

        yield from self._emit(variables)

    def _emit(self, variables: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        yield self.create_text_message(build_review_summary(variables))
        yield self.create_json_message(variables)
        for name, value in variables.items():
            yield self.create_variable_message(name, value)


def create_review_client(credentials: dict[str, Any]) -> ReviewClient:
    """Builds a ReviewClient from provider credentials."""
    base_url = str(credentials.get('review_base_url') or '').strip()
    if not base_url:
        raise ReviewApiError(
            'review_base_url is not configured for this plugin provider'
        )
    return ReviewClient(
        base_url,
        api_token=str(credentials.get('admin_api_token') or '') or None,
    )
