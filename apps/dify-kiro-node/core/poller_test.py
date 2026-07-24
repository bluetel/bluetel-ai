import unittest

from core.poller import TERMINAL_STATUSES, wait_for_terminal_status


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class WaitForTerminalStatusTest(unittest.TestCase):
    def _run(self, statuses, timeout_seconds=60, poll_interval_seconds=5, terminal_statuses=None):
        clock = FakeClock()
        snapshots = iter(statuses)
        fetches = []

        def fetch_task():
            status = next(snapshots)
            fetches.append(status)
            return {'id': 't1', 'status': status}

        def sleep(seconds):
            clock.advance(seconds)

        kwargs = {}
        if terminal_statuses is not None:
            kwargs['terminal_statuses'] = terminal_statuses

        result = wait_for_terminal_status(
            fetch_task,
            timeout_seconds=timeout_seconds,
            poll_interval_seconds=poll_interval_seconds,
            sleep=sleep,
            clock=clock,
            **kwargs,
        )
        return result, fetches

    def test_returns_immediately_when_already_terminal(self):
        result, fetches = self._run(['completed'])
        self.assertFalse(result.timed_out)
        self.assertEqual(result.task['status'], 'completed')
        self.assertEqual(len(fetches), 1)

    def test_polls_until_completed(self):
        result, fetches = self._run(['submitted', 'working', 'working', 'completed'])
        self.assertFalse(result.timed_out)
        self.assertEqual(result.task['status'], 'completed')
        self.assertEqual(len(fetches), 4)
        self.assertEqual(result.elapsed_seconds, 15.0)

    def test_failed_and_canceled_are_terminal(self):
        for status in ['failed', 'canceled']:
            result, _ = self._run(['working', status])
            self.assertFalse(result.timed_out)
            self.assertEqual(result.task['status'], status)

    def test_times_out_and_returns_last_snapshot(self):
        result, fetches = self._run(['working'] * 100, timeout_seconds=12, poll_interval_seconds=5)
        self.assertTrue(result.timed_out)
        self.assertEqual(result.task['status'], 'working')
        # 0s, 5s, 10s fetches; at 12s elapsed >= timeout
        self.assertEqual(len(fetches), 4)

    def test_terminal_statuses_constant(self):
        self.assertEqual(TERMINAL_STATUSES, {'completed', 'failed', 'canceled'})

    def test_custom_terminal_statuses(self):
        # Review statuses: poll until approved, ignoring the default set.
        review_terminal = frozenset({'approved', 'rejected', 'expired'})
        result, fetches = self._run(
            ['pending', 'pending', 'approved'], terminal_statuses=review_terminal
        )
        self.assertFalse(result.timed_out)
        self.assertEqual(result.task['status'], 'approved')
        self.assertEqual(len(fetches), 3)

    def test_default_statuses_are_not_terminal_for_reviews(self):
        # 'completed' must NOT end a review poll when review statuses are used.
        review_terminal = frozenset({'approved', 'rejected', 'expired'})
        result, _ = self._run(
            ['completed', 'completed', 'rejected'], terminal_statuses=review_terminal
        )
        self.assertEqual(result.task['status'], 'rejected')


if __name__ == '__main__':
    unittest.main()
