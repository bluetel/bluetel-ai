"""Session log retrieval for delegated tasks.

The worker writes one session log file per CLI execution, named
``{timestamp}_{engine}_{repo}_{context}.log`` where context is
``task-{taskId}`` for the main execution and ``setup-task-{taskId}``
for the dependency-install phase. The timestamp prefix makes an
alphabetical sort chronological, so a task's setup log naturally
precedes its execution log.

These logs are what gets piped back into the Dify workflow as the
``logs`` output variable for consumption by follow-up nodes.
"""

from typing import Protocol

from core.client import WorkerApiError

MAX_COMBINED_LOG_CHARS = 200_000
TRUNCATION_MARKER = '\n\n[truncated — combined session logs exceed the size limit]'


class LogSource(Protocol):
    """Subset of WorkerClient used for log retrieval (injectable in tests)."""

    def list_logs(self, page: int = 1, page_size: int = 50) -> dict: ...

    def get_log(self, filename: str) -> str: ...


def matching_log_filenames(filenames: list[str], task_id: str) -> list[str]:
    """Filters filenames belonging to the given task, oldest first.

    Matches both ``task-{id}`` and ``setup-task-{id}`` contexts since the
    former is a substring of the latter.
    """
    needle = f'task-{task_id}'
    return sorted(f for f in filenames if needle in f)


def collect_session_logs(
    client: LogSource,
    task_id: str,
    max_pages: int = 4,
    max_chars: int = MAX_COMBINED_LOG_CHARS,
) -> tuple[str, list[str]]:
    """Fetches and combines all session logs for a task.

    Returns ``(combined_text, matched_filenames)``. Each file is wrapped
    in a header naming its source file. Files that fail to download are
    represented by an inline error note rather than failing the whole
    retrieval. Combined output is truncated at ``max_chars``.
    """
    filenames: list[str] = []
    page = 1
    while page <= max_pages:
        listing = client.list_logs(page=page, page_size=50)
        items = listing.get('items', [])
        filenames.extend(
            item['filename'] for item in items if isinstance(item.get('filename'), str)
        )
        total_pages = listing.get('totalPages', 1)
        if not items or page >= total_pages:
            break
        page += 1

    matched = matching_log_filenames(filenames, task_id)

    parts: list[str] = []
    for filename in matched:
        try:
            content = client.get_log(filename)
        except WorkerApiError as err:
            content = f'[failed to fetch log: {err}]'
        parts.append(f'===== {filename} =====\n{content}')

    combined = '\n\n'.join(parts)
    if len(combined) > max_chars:
        combined = combined[: max_chars - len(TRUNCATION_MARKER)] + TRUNCATION_MARKER

    return combined, matched
