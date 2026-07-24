import unittest

from core.client import WorkerApiError, WorkerClient, build_url

BASE_URL = 'http://localhost:3000'
TEST_TOKEN = 'secret'  # nosec B105 — test fixture, not a real credential


class BuildUrlTest(unittest.TestCase):
    def test_joins_base_and_path(self):
        self.assertEqual(build_url(BASE_URL, '/api/tasks'), f'{BASE_URL}/api/tasks')

    def test_strips_trailing_slash(self):
        self.assertEqual(build_url(f'{BASE_URL}/', '/api/tasks'), f'{BASE_URL}/api/tasks')


class WorkerClientTest(unittest.TestCase):
    def test_rejects_invalid_base_url(self):
        for bad in ['', 'localhost:3000', 'ftp://x']:
            with self.assertRaises(WorkerApiError, msg=bad):
                WorkerClient(bad)

    def test_headers_include_bearer_token_when_configured(self):
        client = WorkerClient(BASE_URL, api_token=TEST_TOKEN)
        headers = client._headers(has_body=True)
        self.assertEqual(headers['Authorization'], f'Bearer {TEST_TOKEN}')
        self.assertEqual(headers['Content-Type'], 'application/json')

    def test_headers_omit_authorization_without_token(self):
        client = WorkerClient(BASE_URL)
        headers = client._headers(has_body=False)
        self.assertNotIn('Authorization', headers)
        self.assertNotIn('Content-Type', headers)


if __name__ == '__main__':
    unittest.main()
