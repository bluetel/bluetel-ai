"""HTTP client for the kiro-github-worker admin API.

Uses only the standard library (``urllib``) so the core package has no
third-party dependencies and stays unit-testable without a Dify plugin
runtime environment.

Endpoints used (see kiro-github-worker/src/components/admin-api-router.ts):
- ``POST /api/tasks``          — create a task (same validation as MCP)
- ``GET  /api/tasks/:id``      — unified task status, artifacts, summaries
- ``GET  /api/logs``           — paginated session log file listing
- ``GET  /api/logs/:filename`` — raw session log content (text/plain)
- ``GET  /api/summary``        — health summary (used for credential checks)

Authentication is ``Authorization: Bearer <ADMIN_API_TOKEN>`` and is
optional — the worker accepts unauthenticated requests when no token is
configured.
"""

import json
from typing import Any
from urllib import error, request
from urllib.parse import quote, urlencode, urlparse


class WorkerApiError(Exception):
    """Raised for transport failures and non-2xx worker responses."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def build_url(base_url: str, path: str) -> str:
    """Joins the worker base URL and an absolute API path."""
    return base_url.rstrip('/') + path


class WorkerClient:
    """Thin synchronous client for the worker admin API."""

    def __init__(
        self,
        base_url: str,
        api_token: str | None = None,
        timeout_seconds: float = 30.0,
    ) -> None:
        base_url = (base_url or '').strip()
        if not base_url.startswith(('http://', 'https://')):
            raise WorkerApiError('worker_base_url must start with http:// or https://')
        self._base_url = base_url
        self._api_token = api_token
        self._timeout = timeout_seconds

    # ── Endpoints ─────────────────────────────────────────────────────

    def create_task(self, payload: dict[str, object]) -> dict[str, Any]:
        """Submits a task. Returns the worker's UnifiedTask JSON."""
        return self._request_json('POST', '/api/tasks', body=payload)

    def get_task(self, task_id: str) -> dict[str, Any]:
        """Fetches the current state of a task."""
        return self._request_json('GET', f'/api/tasks/{quote(task_id, safe="")}')

    def list_logs(self, page: int = 1, page_size: int = 50) -> dict[str, Any]:
        """Lists session log files (paginated, newest first)."""
        query = urlencode({'page': page, 'pageSize': page_size})
        return self._request_json('GET', f'/api/logs?{query}')

    def get_log(self, filename: str) -> str:
        """Fetches the raw content of one session log file."""
        _, body = self._request('GET', f'/api/logs/{quote(filename, safe="")}')
        return body.decode('utf-8', errors='replace')

    def get_summary(self) -> dict[str, Any]:
        """Fetches the worker health summary."""
        return self._request_json('GET', '/api/summary')

    # ── Internals ─────────────────────────────────────────────────────

    def _headers(self, has_body: bool) -> dict[str, str]:
        headers = {'Accept': 'application/json'}
        if has_body:
            headers['Content-Type'] = 'application/json'
        if self._api_token:
            headers['Authorization'] = f'Bearer {self._api_token}'
        return headers

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, object] | None = None,
    ) -> tuple[int, bytes]:
        url = build_url(self._base_url, path)
        if urlparse(url).scheme not in ('http', 'https'):
            raise WorkerApiError(f'Refusing to open non-http(s) URL: {url}')
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = request.Request(url, data=data, headers=self._headers(body is not None), method=method)

        try:
            # scheme validated to be http/https above
            with request.urlopen(req, timeout=self._timeout) as res:  # nosec B310
                return res.status, res.read()
        except error.HTTPError as err:
            detail = ''
            try:
                detail = err.read().decode('utf-8', errors='replace')
            except OSError:
                pass
            raise WorkerApiError(
                f'Worker API {method} {path} failed with HTTP {err.code}: {detail[:500]}',
                status=err.code,
            ) from err
        except error.URLError as err:
            raise WorkerApiError(f'Failed to reach worker at {url}: {err.reason}') from err

    def _request_json(
        self,
        method: str,
        path: str,
        body: dict[str, object] | None = None,
    ) -> dict[str, Any]:
        _, raw = self._request(method, path, body=body)
        try:
            parsed = json.loads(raw.decode('utf-8'))
        except (json.JSONDecodeError, UnicodeDecodeError) as err:
            raise WorkerApiError(
                f'Worker API {method} {path} returned invalid JSON: {raw[:200]!r}'
            ) from err
        if not isinstance(parsed, dict):
            raise WorkerApiError(f'Worker API {method} {path} returned non-object JSON')
        return parsed
