/**
 * The agent's own credential, as the output pipeline knows it (003/T054,
 * 003/FR-014, 003/SC-014).
 *
 * FR-014 says the material must pass through the **existing** redaction
 * pipeline as a known value, and that word is the requirement: not a new filter,
 * not a pattern written to match whatever shape this provider's tokens happen to
 * have today, but the same known-value mechanism that already removes every
 * credential the setup bundle installed. Known values are the half of the
 * two-stage redactor that does not depend on anticipating a format, which is
 * exactly the property wanted here — the material is opaque bytes read off a
 * file, and nothing in this process is entitled to assume anything about it.
 *
 * There are two moments a value belongs in the registry, and both go through
 * {@link agentCredentialSecret}:
 *
 * 1. **Install**, in bootstrap phase `credential_install`, with the material the
 *    machine surface handed over (`bootstrap/credential-install.ts`).
 * 2. **Rotation**, whenever the agent refreshes its own login mid-run
 *    (`credential/rotation-watch.ts`). The rotated material is a value nothing
 *    in this process has ever seen before, and it is registered **before** it is
 *    reported anywhere — so there is no window in which the newest material is
 *    live on the box and unknown to the redactor.
 *
 * The name is fixed rather than derived from the credential's id. The
 * placeholder is what an operator reads in a log, names in it are not secret and
 * lengths are, and `agent-credential` says the useful thing — *the agent's
 * login was removed here* — without carrying an identifier that would let two
 * log lines be correlated to the same seat.
 */

import type { KnownSecret } from './secret-values'

/**
 * The label that appears in the placeholder: `[redacted:agent-credential]`.
 *
 * Matches `secret-values.ts`'s `SAFE_NAME`, so it survives into the placeholder
 * verbatim rather than falling back to the neutral `credential` label.
 */
export const AGENT_CREDENTIAL_SECRET_NAME = 'agent-credential'

/**
 * The material, in the shape the redactor takes.
 *
 * @param material - Exactly the bytes fetched from the machine surface or read
 *   back off the agent's credential file. Not trimmed, not parsed and not
 *   reformatted: what is redacted has to be what would appear if something
 *   echoed the file, and any normalisation here would produce a known value that
 *   differs from the bytes actually on disk.
 */
export const agentCredentialSecret = (material: string): KnownSecret => ({
  name: AGENT_CREDENTIAL_SECRET_NAME,
  value: material,
})
