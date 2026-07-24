import unittest

from core.engines import CLAUDE, COPILOT, KIRO, EngineSpec, engine_names, get_engine, register_engine


class GetEngineTest(unittest.TestCase):
    def test_returns_registered_kiro_engine(self):
        spec = get_engine('kiro')
        self.assertIs(spec, KIRO)
        self.assertEqual(spec.worker_engine, 'kiro')
        self.assertTrue(spec.supports_agent)
        self.assertTrue(spec.supports_model)

    def test_returns_registered_copilot_engine(self):
        spec = get_engine('copilot')
        self.assertIs(spec, COPILOT)
        self.assertFalse(spec.supports_agent)
        self.assertFalse(spec.supports_model)

    def test_returns_registered_claude_engine(self):
        spec = get_engine('claude')
        self.assertIs(spec, CLAUDE)
        self.assertEqual(spec.worker_engine, 'claude')
        self.assertFalse(spec.supports_agent)
        self.assertFalse(spec.supports_model)

    def test_unknown_engine_raises_with_known_names(self):
        with self.assertRaises(ValueError) as ctx:
            get_engine('claude_code')
        message = str(ctx.exception)
        self.assertIn('claude_code', message)
        self.assertIn('kiro', message)
        self.assertIn('copilot', message)
        self.assertIn('claude', message)


class RegisterEngineTest(unittest.TestCase):
    def test_registered_engine_is_resolvable(self):
        spec = EngineSpec(
            name='test_engine',
            worker_engine='test-engine',
            label='Test Engine',
            supports_agent=True,
            supports_model=False,
        )
        register_engine(spec)
        try:
            self.assertIs(get_engine('test_engine'), spec)
            self.assertIn('test_engine', engine_names())
        finally:
            # Remove to keep the registry clean for other tests
            from core import engines

            del engines._REGISTRY['test_engine']


if __name__ == '__main__':
    unittest.main()
