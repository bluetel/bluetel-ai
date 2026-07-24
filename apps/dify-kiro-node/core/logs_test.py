import unittest

from core.client import WorkerApiError
from core.logs import collect_session_logs, matching_log_filenames

TASK_ID = 'abc-123'
MAIN_LOG_CONTENT = 'MAIN OUTPUT'
SETUP_LOG_CONTENT = 'SETUP OUTPUT'


class FakeLogSource:
    def __init__(self, pages, contents=None, fail_files=None):
        self.pages = pages
        self.contents = contents or {}
        self.fail_files = fail_files or set()

    def list_logs(self, page=1, page_size=50):
        items = self.pages[page - 1] if page <= len(self.pages) else []
        return {
            'items': [{'filename': f} for f in items],
            'totalPages': len(self.pages),
            'page': page,
        }

    def get_log(self, filename):
        if filename in self.fail_files:
            raise WorkerApiError('boom', status=404)
        return self.contents.get(filename, f'content of {filename}')


class MatchingLogFilenamesTest(unittest.TestCase):
    def test_matches_task_and_setup_logs_sorted(self):
        filenames = [
            f'20260612-110000-000_kiro_acme_widgets_task-{TASK_ID}.log',
            f'20260612-100000-000_kiro_acme_widgets_setup-task-{TASK_ID}.log',
            '20260612-090000-000_kiro_acme_widgets_task-other-id.log',
        ]
        matched = matching_log_filenames(filenames, TASK_ID)
        self.assertEqual(len(matched), 2)
        self.assertIn('setup-task', matched[0])
        self.assertNotIn('other-id', ''.join(matched))

    def test_no_matches(self):
        self.assertEqual(matching_log_filenames(['a.log'], TASK_ID), [])


class CollectSessionLogsTest(unittest.TestCase):
    def test_combines_matched_logs_with_headers(self):
        setup = f'20260612-100000-000_kiro_acme_widgets_setup-task-{TASK_ID}.log'
        main = f'20260612-110000-000_kiro_acme_widgets_task-{TASK_ID}.log'
        source = FakeLogSource(
            pages=[[main, setup, 'unrelated.log']],
            contents={setup: SETUP_LOG_CONTENT, main: MAIN_LOG_CONTENT},
        )
        combined, files = collect_session_logs(source, TASK_ID)
        self.assertEqual(files, [setup, main])
        self.assertIn(f'===== {setup} =====', combined)
        self.assertIn(SETUP_LOG_CONTENT, combined)
        self.assertIn(MAIN_LOG_CONTENT, combined)
        self.assertLess(combined.index(SETUP_LOG_CONTENT), combined.index(MAIN_LOG_CONTENT))

    def test_walks_multiple_pages(self):
        first = f'20260612-100000-000_kiro_acme_widgets_task-{TASK_ID}.log'
        source = FakeLogSource(pages=[['x.log'], [first]])
        _, files = collect_session_logs(source, TASK_ID)
        self.assertEqual(files, [first])

    def test_fetch_failure_is_inlined_not_raised(self):
        name = f'20260612-100000-000_kiro_acme_widgets_task-{TASK_ID}.log'
        source = FakeLogSource(pages=[[name]], fail_files={name})
        combined, files = collect_session_logs(source, TASK_ID)
        self.assertEqual(files, [name])
        self.assertIn('[failed to fetch log:', combined)

    def test_truncates_combined_output(self):
        name = f'20260612-100000-000_kiro_acme_widgets_task-{TASK_ID}.log'
        source = FakeLogSource(pages=[[name]], contents={name: 'x' * 1000})
        combined, _ = collect_session_logs(source, TASK_ID, max_chars=200)
        self.assertEqual(len(combined), 200)
        self.assertTrue(combined.endswith('size limit]'))

    def test_no_logs_returns_empty(self):
        source = FakeLogSource(pages=[[]])
        combined, files = collect_session_logs(source, TASK_ID)
        self.assertEqual(combined, '')
        self.assertEqual(files, [])


if __name__ == '__main__':
    unittest.main()
