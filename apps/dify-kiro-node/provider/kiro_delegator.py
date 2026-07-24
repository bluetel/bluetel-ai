"""Provider credential validation for the Kiro Delegator plugin.

Verifies the configured worker base URL (and optional admin API token)
by calling the worker's ``GET /api/summary`` health endpoint.
"""

from typing import Any

from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError

from core.client import WorkerApiError, WorkerClient


class KiroDelegatorProvider(ToolProvider):
    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        base_url = str(credentials.get('worker_base_url') or '').strip()
        if not base_url:
            raise ToolProviderCredentialValidationError('Worker Base URL is required')

        try:
            client = WorkerClient(
                base_url,
                api_token=str(credentials.get('admin_api_token') or '') or None,
                timeout_seconds=10,
            )
            client.get_summary()
        except WorkerApiError as err:
            raise ToolProviderCredentialValidationError(
                f'Could not reach the worker admin API: {err}'
            ) from err
