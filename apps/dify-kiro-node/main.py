from dify_plugin import DifyPluginEnv, Plugin

# Delegated coding tasks and human reviews can both block for a long time —
# allow up to four hours before the plugin daemon aborts a tool invocation.
# The per-call wait is bounded separately by each tool's `timeout_minutes`
# parameter (delegate_task up to 110 min, request_review up to 240 min).
plugin = Plugin(DifyPluginEnv(MAX_REQUEST_TIMEOUT=14400))

if __name__ == '__main__':
    plugin.run()
