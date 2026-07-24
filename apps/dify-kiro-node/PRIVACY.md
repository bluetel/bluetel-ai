# Privacy Policy — Kiro Task Delegator

This plugin acts as a bridge between a Dify workflow and a self-hosted
kiro-github-worker instance.

## Data handled

- **Task inputs** (repository URL, branch, prompt, context, acceptance
  criteria, install script) are sent to the worker instance configured by
  the plugin administrator and to no other destination.
- **Credentials** (worker base URL and admin API token) are stored by the
  Dify platform's credential storage and are only used to authenticate
  requests to the configured worker.
- **Task outputs and session logs** are fetched from the worker and
  returned into the invoking workflow. The plugin does not persist any
  data itself.

## Third parties

The plugin makes HTTP requests exclusively to the worker base URL
configured in the provider credentials. No analytics, telemetry, or
other third-party services are contacted.
