import unittest

from core.engines import COPILOT, KIRO
from core.payload import build_task_payload

REPO = 'https://github.com/acme/widgets'
PROMPT = 'Do it'


class BuildTaskPayloadTest(unittest.TestCase):
    def test_minimal_kiro_payload(self):
        payload, warnings = build_task_payload(REPO, 'main', 'Do the thing', KIRO)
        self.assertEqual(
            payload,
            {
                'repoUrl': REPO,
                'baseBranch': 'main',
                'prompt': 'Do the thing',
                'engine': 'kiro',
            },
        )
        self.assertEqual(warnings, [])

    def test_kiro_forwards_agent_and_model(self):
        payload, warnings = build_task_payload(
            REPO, 'main', PROMPT, KIRO, agent='spec-orchestrator', model='claude-sonnet-4-6'
        )
        self.assertEqual(payload['agent'], 'spec-orchestrator')
        self.assertEqual(payload['model'], 'claude-sonnet-4-6')
        self.assertEqual(warnings, [])

    def test_copilot_drops_agent_and_model_with_warnings(self):
        payload, warnings = build_task_payload(
            REPO, 'main', PROMPT, COPILOT, agent='some-agent', model='gpt-5'
        )
        self.assertNotIn('agent', payload)
        self.assertNotIn('model', payload)
        self.assertEqual(len(warnings), 2)
        self.assertIn('agent', warnings[0])
        self.assertIn('model', warnings[1])

    def test_install_script_included_when_present(self):
        payload, _ = build_task_payload(REPO, 'main', PROMPT, KIRO, install_script='pnpm i')
        self.assertEqual(payload['installScript'], 'pnpm i')

    def test_blank_optional_fields_omitted(self):
        payload, warnings = build_task_payload(
            REPO, 'main', PROMPT, KIRO, agent='  ', model='', install_script='  '
        )
        self.assertNotIn('agent', payload)
        self.assertNotIn('model', payload)
        self.assertNotIn('installScript', payload)
        self.assertEqual(warnings, [])

    def test_invalid_repo_url_raises(self):
        for bad in ['', 'github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com/a']:
            with self.assertRaises(ValueError, msg=bad):
                build_task_payload(bad, 'main', PROMPT, KIRO)

    def test_repo_url_with_git_suffix_is_accepted(self):
        payload, _ = build_task_payload(f'{REPO}.git', 'main', PROMPT, KIRO)
        self.assertEqual(payload['repoUrl'], f'{REPO}.git')

    def test_invalid_base_branch_raises(self):
        for bad in ['', 'has space', 'bad~ref']:
            with self.assertRaises(ValueError, msg=bad):
                build_task_payload(REPO, bad, PROMPT, KIRO)

    def test_branch_with_slashes_and_dots_is_accepted(self):
        payload, _ = build_task_payload(REPO, 'feature/BTAI-123.x', PROMPT, KIRO)
        self.assertEqual(payload['baseBranch'], 'feature/BTAI-123.x')

    def test_empty_prompt_raises(self):
        with self.assertRaises(ValueError):
            build_task_payload(REPO, 'main', '   ', KIRO)


if __name__ == '__main__':
    unittest.main()
