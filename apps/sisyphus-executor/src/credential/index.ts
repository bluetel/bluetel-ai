/**
 * The agent credential, once it is on the instance (003/T059).
 *
 * A small surface on purpose. Getting the credential *onto* the box is a
 * bootstrap phase and lives in `bootstrap/credential-install.ts`, because it is
 * timed and reported like every other phase and belongs with them. What is left
 * for this directory is the half that outlives bootstrap: noticing that the
 * agent has refreshed its own login and writing that back before the instance
 * can die with it (FR-030).
 *
 * Consumers import from here and never from the module behind it.
 */

export {
  DEFAULT_ROTATION_DEBOUNCE_MS,
  watchCredentialFile,
  watchForRotation,
} from './rotation-watch'
export type {
  CredentialFileWatcher,
  CredentialRotationAnswer,
  CredentialRotationRejection,
  CredentialRotationReporter,
  RotationFlushOutcome,
  RotationWatch,
  RotationWatchOptions,
} from './rotation-watch'
