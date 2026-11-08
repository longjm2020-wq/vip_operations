import unittest
from start import configuration


class StartupConfigurationTests(unittest.TestCase):
    def environment(self):
        return {
            "DEER_FLOW_INTERNAL_AUTH_TOKEN": "a" * 64,
            "DEER_FLOW_MODEL_PROXY_TOKEN": "b" * 64,
            "AUTH_JWT_SECRET": "c" * 64,
            "ERP_API_BASE": "http://vip-api.railway.internal:3100",
        }

    def test_gateway_scope_and_persistence(self):
        config = configuration(self.environment())
        self.assertFalse(config["sandbox"]["allow_host_bash"])
        self.assertFalse(config["auth"]["local"]["allow_registration"])
        self.assertEqual(config["database"]["sqlite_dir"], "/data/deerflow/data")
        self.assertEqual(config["run_events"]["backend"], "db")
        self.assertEqual(config["models"][0]["max_retries"], 0)
        self.assertEqual(config["llm_call"]["retry_max_attempts"], 1)
        self.assertEqual(config["recursion_limit"], 300)
        self.assertEqual(config["max_recursion_limit"], 400)
        self.assertEqual(config["token_budget"]["max_tokens"], 200000)
        self.assertEqual(config["subagents"]["max_total_per_run"], 6)
        self.assertEqual(config["subagents"]["max_turns"], 25)
        self.assertEqual(config["subagents"]["timeout_seconds"], 600)
        self.assertEqual(config["subagent_runtime"]["max_running"], 2)
        self.assertEqual(config["models"][0]["api_key"], "$DEER_FLOW_MODEL_PROXY_TOKEN")
        self.assertEqual({tool["name"] for tool in config["tools"]}, {"web_search", "web_fetch", "ls", "read_file", "glob", "grep", "write_file", "str_replace"})

    def test_rejects_missing_reused_credentials_and_auth_bypass(self):
        for updates in ({"AUTH_JWT_SECRET": ""}, {"DEER_FLOW_MODEL_PROXY_TOKEN": "a" * 64}, {"DEER_FLOW_AUTH_DISABLED": "1"}):
            with self.subTest(updates=tuple(updates)):
                with self.assertRaises(ValueError):
                    configuration(self.environment() | updates)

    def test_rejects_credentials_paths_and_public_plaintext_origins(self):
        for origin in ("http://example.com", "https://token@example.com", "https://example.com/path", "https://example.com?token=secret"):
            with self.subTest(origin=origin):
                with self.assertRaises(ValueError):
                    configuration(self.environment() | {"ERP_API_BASE": origin})


if __name__ == "__main__":
    unittest.main()
