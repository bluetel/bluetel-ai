"""Builds workflow output variables from a review API response.

The ``request_review`` tool emits a flat set of typed variables so a
downstream Dify IF/ELSE node can route on the human's decision (e.g.
``approved`` to continue, ``rejected`` to loop back) and feed the
reviewer's ``comment`` into the next iteration.
"""

from typing import Any

# Statuses from which a review will not change further. Mirrors
# TERMINAL_REVIEW_STATUSES in the worker.
REVIEW_TERMINAL_STATUSES: frozenset[str] = frozenset({'approved', 'rejected', 'expired'})


def build_review_variables(
    review: dict[str, Any],
    timed_out: bool,
    elapsed_seconds: float,
    review_app_url: str = '',
) -> dict[str, Any]:
    """Maps a serialized review into downstream workflow variables."""
    status = str(review.get('status') or ('pending' if timed_out else 'unknown'))
    decision = str(review.get('decision') or '')
    review_id = str(review.get('id') or '')

    return {
        'review_id': review_id,
        'status': status,
        'decision': decision,
        'approved': decision == 'approved',
        'rejected': decision == 'rejected',
        'comment': str(review.get('comment') or ''),
        'reviewer': str(review.get('reviewer') or ''),
        'timed_out': timed_out,
        'expired': status == 'expired',
        'iteration': review.get('iteration'),
        'error': '',
        'review_url': _review_url(review_app_url, review_id),
        'elapsed_seconds': round(elapsed_seconds, 1),
    }


def build_error_review_variables(message: str) -> dict[str, Any]:
    """Builds variables for a review that could not be created or fetched."""
    return {
        'review_id': '',
        'status': 'error',
        'decision': '',
        'approved': False,
        'rejected': False,
        'comment': '',
        'reviewer': '',
        'timed_out': False,
        'expired': False,
        'iteration': None,
        'error': message,
        'review_url': '',
        'elapsed_seconds': 0.0,
    }


def build_review_summary(variables: dict[str, Any]) -> str:
    """Produces a one-line human-readable summary of the review outcome."""
    if variables.get('error'):
        return f'Review failed: {variables["error"]}'
    status = variables.get('status', 'unknown')
    if variables.get('timed_out'):
        return f'Review {variables.get("review_id", "")} timed out while still pending'
    comment = variables.get('comment') or ''
    suffix = f' — "{comment}"' if comment else ''
    reviewer = variables.get('reviewer') or 'a reviewer'
    return f'Review {status} by {reviewer}{suffix}'


def _review_url(app_url: str, review_id: str) -> str:
    """Builds a dashboard deep link to a review, when an app URL is set."""
    app_url = (app_url or '').strip().rstrip('/')
    if not app_url or not review_id:
        return ''
    return f'{app_url}/reviews?id={review_id}'
