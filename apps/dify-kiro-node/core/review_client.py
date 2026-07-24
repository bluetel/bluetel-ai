"""HTTP client for the human-review API on the kiro-github-worker.

Mirrors ``core.client.WorkerClient`` but targets the review endpoints used
by the synchronous ``request_review`` tool. Uses only the standard library
(``urllib``) so the core package stays dependency-free and unit-testable
without a Dify plugin runtime.

Endpoints used (see kiro-github-worker/src/components/review-api-router.ts):
- ``POST /api/reviews``         — create a review request
- ``GET  /api/reviews/:id``     — fetch a review's status and decision

Authentication is ``Authorization: Bearer <token>`` and is optional — the
worker accepts unauthenticated requests when no admin token is configured.
"""

import json
from typing import Any
from urllib import error, request
from urllib.parse import quote, urlparse


class ReviewApiError(Exception):
    """Raised for transport failures and non-2xx review API responses."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def build_url(base_url: str, path: str) -> str:
    """Joins the review API base URL and an absolute API path."""
    return base_url.rstrip('/') + path


class ReviewClient:
    """Thin synchronous client for the worker review API."""

    def __init__(
        self,
        base_url: str,
        api_token: str | None = None,
        timeout_seconds: float = 30.0,
    ) -> None:
        base_url = (base_url or '').strip()
        if not base_url.startswith(('http://', 'https://')):
            raise ReviewApiError('review_base_url must start with http:// or https://')
        self._base_url = base_url
        self._api_token = api_token
        self._timeout = timeout_seconds

    # ── Endpoints ─────────────────────────────────────────────────────

    def create_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Creates a review request. Returns the serialized review JSON."""
        return self._request_json('POST', '/api/reviews', body=payload)

    def get_review(self, review_id: str) -> dict[str, Any]:
        """Fetches the current state of a review."""
        return self._request_json('GET', f'/api/reviews/{quote(review_id, safe="")}')

    # ── Internals ─────────────────────────────────────────────────────

    def _headers(self, has_body: bool) -> dict[str, str]:
        headers = {'Accept': 'application/json'}
        if has_body:
            headers['Content-Type'] = 'application/json'
        if self._api_token:
            headers['Authorization'] = f'Bearer {self._api_token}'
        return headers

    def _request_json(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = build_url(self._base_url, path)
        if urlparse(url).scheme not in ('http', 'https'):
            raise ReviewApiError(f'Refusing to open non-http(s) URL: {url}')
        data = json.dumps(body).encode('utf-8') if body is not None else None
        req = request.Request(
            url, data=data, headers=self._headers(body is not None), method=method
        )

        try:
            with request.urlopen(req, timeout=self._timeout) as res:  # nosec B310 - scheme validated above
                raw = res.read()
        except error.HTTPError as err:
            detail = ''
            try:
                detail = err.read().decode('utf-8', errors='replace')
            except OSError:
                pass
            raise ReviewApiError(
                f'Review API {method} {path} failed with HTTP {err.code}: {detail[:500]}',
                status=err.code,
            ) from err
        except error.URLError as err:
            raise ReviewApiError(f'Failed to reach review API at {url}: {err.reason}') from err

        try:
            parsed = json.loads(raw.decode('utf-8'))
        except (json.JSONDecodeError, UnicodeDecodeError) as err:
            raise ReviewApiError(
                f'Review API {method} {path} returned invalid JSON: {raw[:200]!r}'
            ) from err
        if not isinstance(parsed, dict):
            raise ReviewApiError(f'Review API {method} {path} returned non-object JSON')
        return parsed
