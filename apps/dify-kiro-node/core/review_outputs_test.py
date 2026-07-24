import unittest

from core.review_outputs import (
    REVIEW_TERMINAL_STATUSES,
    build_error_review_variables,
    build_review_summary,
    build_review_variables,
)


def make_review(**overrides):
    review = {
        'id': 'r1',
        'status': 'approved',
        'decision': 'approved',
        'comment': '',
        'reviewer': '',
        'iteration': None,
    }
    review.update(overrides)
    return review


class BuildReviewVariablesTest(unittest.TestCase):
    def test_approved_sets_routing_booleans(self):
        variables = build_review_variables(
            make_review(decision='approved', reviewer='harry', comment='ok'),
            timed_out=False,
            elapsed_seconds=12.34,
        )
        self.assertTrue(variables['approved'])
        self.assertFalse(variables['rejected'])
        self.assertEqual(variables['decision'], 'approved')
        self.assertEqual(variables['reviewer'], 'harry')
        self.assertEqual(variables['comment'], 'ok')
        self.assertEqual(variables['elapsed_seconds'], 12.3)
        self.assertEqual(variables['error'], '')

    def test_rejected_sets_routing_booleans(self):
        variables = build_review_variables(
            make_review(status='rejected', decision='rejected', comment='nope'),
            timed_out=False,
            elapsed_seconds=1.0,
        )
        self.assertTrue(variables['rejected'])
        self.assertFalse(variables['approved'])

    def test_timed_out_review_is_pending(self):
        variables = build_review_variables(
            {'id': 'r1', 'status': 'pending', 'decision': None},
            timed_out=True,
            elapsed_seconds=3600.0,
        )
        self.assertTrue(variables['timed_out'])
        self.assertEqual(variables['status'], 'pending')
        self.assertFalse(variables['approved'])
        self.assertFalse(variables['rejected'])

    def test_expired_flag(self):
        variables = build_review_variables(
            {'id': 'r1', 'status': 'expired', 'decision': None},
            timed_out=False,
            elapsed_seconds=1.0,
        )
        self.assertTrue(variables['expired'])

    def test_builds_deep_link_when_app_url_set(self):
        variables = build_review_variables(
            make_review(),
            timed_out=False,
            elapsed_seconds=1.0,
            review_app_url='https://dash.example.com/',
        )
        self.assertEqual(variables['review_url'], 'https://dash.example.com/reviews?id=r1')

    def test_no_deep_link_without_app_url(self):
        variables = build_review_variables(make_review(), timed_out=False, elapsed_seconds=1.0)
        self.assertEqual(variables['review_url'], '')


class BuildErrorReviewVariablesTest(unittest.TestCase):
    def test_error_variables(self):
        variables = build_error_review_variables('boom')
        self.assertEqual(variables['status'], 'error')
        self.assertEqual(variables['error'], 'boom')
        self.assertFalse(variables['approved'])
        self.assertFalse(variables['rejected'])


class BuildReviewSummaryTest(unittest.TestCase):
    def test_summarises_decision_with_comment(self):
        variables = build_review_variables(
            make_review(reviewer='harry', comment='ship it'),
            timed_out=False,
            elapsed_seconds=1.0,
        )
        self.assertEqual(build_review_summary(variables), 'Review approved by harry — "ship it"')

    def test_summarises_timeout(self):
        variables = build_review_variables(
            {'id': 'r1', 'status': 'pending'}, timed_out=True, elapsed_seconds=1.0
        )
        self.assertIn('timed out', build_review_summary(variables))

    def test_summarises_error(self):
        self.assertEqual(
            build_review_summary(build_error_review_variables('boom')),
            'Review failed: boom',
        )


class TerminalStatusesTest(unittest.TestCase):
    def test_constant(self):
        self.assertEqual(REVIEW_TERMINAL_STATUSES, {'approved', 'rejected', 'expired'})


if __name__ == '__main__':
    unittest.main()
