"""Polling loop for waiting on worker task completion.

The worker enqueues tasks asynchronously, so the synchronous
``delegate_task`` tool polls ``GET /api/tasks/:id`` until the task
reaches a terminal status or the configured timeout elapses. ``sleep``
and ``clock`` are injectable for deterministic tests.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

TERMINAL_STATUSES = frozenset({'completed', 'failed', 'canceled'})


@dataclass(frozen=True)
class PollResult:
    """Outcome of a polling run."""

    task: dict[str, Any]
    """The last task snapshot fetched."""

    timed_out: bool
    """True when the timeout elapsed before a terminal status."""

    elapsed_seconds: float
    """Wall-clock time spent polling."""


def wait_for_terminal_status(
    fetch_task: Callable[[], dict[str, Any]],
    timeout_seconds: float,
    poll_interval_seconds: float = 5.0,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    terminal_statuses: frozenset[str] = TERMINAL_STATUSES,
) -> PollResult:
    """Polls ``fetch_task`` until the task is terminal or time runs out.

    Never raises on timeout — returns the last snapshot with
    ``timed_out=True`` so callers can still surface partial state
    (status, summaries, logs collected so far) to the workflow.

    ``terminal_statuses`` defaults to coding-task statuses but can be
    overridden (e.g. for human reviews, which settle on approved /
    rejected / expired).
    """
    start = clock()
    task = fetch_task()

    while task.get('status') not in terminal_statuses:
        elapsed = clock() - start
        if elapsed >= timeout_seconds:
            return PollResult(task=task, timed_out=True, elapsed_seconds=elapsed)
        sleep(min(poll_interval_seconds, timeout_seconds - elapsed))
        task = fetch_task()

    return PollResult(task=task, timed_out=False, elapsed_seconds=clock() - start)
