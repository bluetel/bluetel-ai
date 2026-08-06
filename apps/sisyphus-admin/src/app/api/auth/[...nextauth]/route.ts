import { handlers } from '@sisyphus-admin/lib/auth'

/**
 * Auth.js route handler — Google Workspace sign-in with a **server-verified** `hd` claim and
 * **database-backed** sessions (FR-011, FR-175).
 *
 * The handler itself is thin on purpose: everything that can be got wrong lives in
 * `src/lib/auth/`, where it is a pure function with a colocated test. A domain check that could
 * only be exercised by running a real OAuth round trip is a domain check nobody re-tests.
 */
export const { GET, POST } = handlers
