import unittest

from core.engines import KIRO
from core.outputs import (
    artifact_value,
    build_error_variables,
    build_result_variables,
    build_summary_text,
)

STDOUT_OUTPUT = 'cli output'
RESULT_SUMMARY = 'Bug fixed, PR opened'
LOG_FILENAME = 'a.log'

COMPLETED_TASK = {
    'id': 'task-1',
    'status': 'completed',
    'input': {'agent': 'spec-orchestrator'},
    'artifacts': [
        {'type': 'stdout', 'value': STDOUT_OUTPUT},
        {'type': 'branch', 'value': 'Changes pushed to remote'},
    ],
    'promptSummary': 'Fix the bug',
    'resultSummary': RESULT_SUMMARY,
}


class ArtifactValueTest(unittest.TestCase):
    def test_returns_first_matching_artifact(self):
        self.assertEqual(artifact_value(COMPLETED_TASK, 'stdout'), STDOUT_OUTPUT)

    def test_missing_type_returns_empty(self):
        self.assertEqual(artifact_value(COMPLETED_TASK, 'nope'), '')

    def test_handles_missing_artifacts_key(self):
        self.assertEqual(artifact_value({}, 'stdout'), '')


class BuildResultVariablesTest(unittest.TestCase):
    def test_completed_task(self):
        variables = build_result_variables(
            COMPLETED_TASK,
            KIRO,
            warnings=['w1'],
            logs_text='LOGS',
            log_files=[LOG_FILENAME],
            elapsed_seconds=12.34,
        )
        self.assertEqual(variables['task_id'], 'task-1')
        self.assertEqual(variables['status'], 'completed')
        self.assertTrue(variables['success'])
        self.assertFalse(variables['timed_out'])
        self.assertEqual(variables['error'], '')
        self.assertEqual(variables['result_summary'], RESULT_SUMMARY)
        self.assertEqual(variables['stdout'], STDOUT_OUTPUT)
        self.assertTrue(variables['has_changes'])
        self.assertEqual(variables['engine'], 'kiro')
        self.assertEqual(variables['agent'], 'spec-orchestrator')
        self.assertEqual(variables['warnings'], ['w1'])
        self.assertEqual(variables['logs'], 'LOGS')
        self.assertEqual(variables['log_files'], [LOG_FILENAME])
        self.assertEqual(variables['elapsed_seconds'], 12.3)

    def test_failed_task_surfaces_error(self):
        task = {
            'id': 'task-2',
            'status': 'failed',
            'error': {'step': 'clone', 'message': 'auth denied'},
        }
        variables = build_result_variables(task, KIRO, warnings=[])
        self.assertFalse(variables['success'])
        self.assertEqual(variables['error'], '[clone] auth denied')
        self.assertFalse(variables['has_changes'])

    def test_timed_out_task_is_not_success(self):
        task = {'id': 'task-3', 'status': 'working'}
        variables = build_result_variables(task, KIRO, warnings=[], timed_out=True)
        self.assertFalse(variables['success'])
        self.assertTrue(variables['timed_out'])
        self.assertIn('Timed out', variables['error'])

    def test_elapsed_omitted_when_not_provided(self):
        variables = build_result_variables({'id': 't', 'status': 'completed'}, KIRO, warnings=[])
        self.assertNotIn('elapsed_seconds', variables)


class BuildErrorVariablesTest(unittest.TestCase):
    def test_shape_matches_result_variables(self):
        error_vars = build_error_variables('worker unreachable', KIRO, warnings=['w'])
        result_vars = build_result_variables({'id': 't', 'status': 'completed'}, KIRO, warnings=[])
        self.assertEqual(set(error_vars), set(result_vars))
        self.assertEqual(error_vars['status'], 'error')
        self.assertFalse(error_vars['success'])
        self.assertEqual(error_vars['error'], 'worker unreachable')


class BuildSummaryTextTest(unittest.TestCase):
    def test_summary_for_completed_task(self):
        variables = build_result_variables(
            COMPLETED_TASK, KIRO, warnings=['agent ignored'], log_files=[LOG_FILENAME]
        )
        text = build_summary_text(variables)
        self.assertIn('task-1', text)
        self.assertIn('completed', text)
        self.assertIn(RESULT_SUMMARY, text)
        self.assertIn('Changes were pushed', text)
        self.assertIn('Warning: agent ignored', text)
        self.assertIn('1 file(s)', text)

    def test_summary_for_error(self):
        text = build_summary_text(build_error_variables('boom', KIRO))
        self.assertIn('(not created)', text)
        self.assertIn('Error: boom', text)


if __name__ == '__main__':
    unittest.main()
