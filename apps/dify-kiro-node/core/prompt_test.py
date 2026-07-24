import unittest

from core.prompt import build_task_prompt, join_sections

TASK_PROMPT = 'Fix the bug'


class JoinSectionsTest(unittest.TestCase):
    def test_joins_with_blank_lines(self):
        self.assertEqual(join_sections('a', 'b'), 'a\n\nb')

    def test_skips_empty_sections(self):
        self.assertEqual(join_sections('a', '', 'b'), 'a\n\nb')


class BuildTaskPromptTest(unittest.TestCase):
    def test_prompt_only(self):
        self.assertEqual(build_task_prompt(TASK_PROMPT), TASK_PROMPT)

    def test_empty_prompt_raises(self):
        with self.assertRaises(ValueError):
            build_task_prompt('   ')

    def test_includes_context_section(self):
        result = build_task_prompt(TASK_PROMPT, context='Earlier agent found X')
        self.assertIn('--- CONTEXT FROM PREVIOUS STEP ---', result)
        self.assertIn('Earlier agent found X', result)
        self.assertIn('--- END CONTEXT ---', result)
        self.assertTrue(result.startswith(TASK_PROMPT))

    def test_includes_acceptance_criteria_section(self):
        result = build_task_prompt(TASK_PROMPT, acceptance_criteria='Tests must pass')
        self.assertIn('--- ACCEPTANCE CRITERIA ---', result)
        self.assertIn('Tests must pass', result)

    def test_blank_optional_sections_are_omitted(self):
        result = build_task_prompt(TASK_PROMPT, context='  ', acceptance_criteria='')
        self.assertEqual(result, TASK_PROMPT)

    def test_section_ordering(self):
        result = build_task_prompt('Task', context='Ctx', acceptance_criteria='AC')
        self.assertLess(result.index('Task'), result.index('CONTEXT FROM PREVIOUS STEP'))
        self.assertLess(result.index('END CONTEXT'), result.index('ACCEPTANCE CRITERIA'))


if __name__ == '__main__':
    unittest.main()
