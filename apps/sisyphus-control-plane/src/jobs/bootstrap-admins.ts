import type { SisyphusDatabase, User } from '@bluetel-ai/sisyphus-api/db'
import { getDatabaseClient, roleChanges, users } from '@bluetel-ai/sisyphus-api/db'
import { eq } from 'drizzle-orm'

import type { JobOutcome } from './run-job'
import { runJob } from './run-job'

/**
 * The bootstrap-admin reconcile (FR-174) — the step that breaks the first-admin deadlock.
 *
 * Users are auto-created as `engineer` (FR-170) and every route to `admin` requires an existing
 * admin (FR-169), so without a seed there is no admin and no configuration of any kind can be
 * performed. This job reads `SISYPHUS_BOOTSTRAP_ADMIN_EMAILS` from deploy-time configuration and,
 * for each address, promotes the existing user row or creates one pre-authorised so the promotion
 * also covers someone who has not yet signed in.
 *
 * **A reconcile, not a one-shot migration.** It runs after migration on *every* deploy and
 * compares desired state against actual, writing only where they differ. That is what makes
 * recovery from the never-zero-admins state — every admin deactivated, nobody left able to
 * re-grant — a redeploy rather than a manual database edit, and it is why the reconcile
 * reactivates a deactivated bootstrap admin as well as promoting a demoted one. Removing an
 * address does **not** demote anyone: revocation stays an explicit, attributed action.
 *
 * **It writes the database directly rather than calling a procedure.** `admin.users.setRole` is an
 * `adminProcedure`, and requiring an admin session to create the first admin is the exact deadlock
 * this job exists to break. There is no in-process caller path that could work, so the job takes a
 * database handle and writes `users` and `role_changes` itself, inside one transaction.
 *
 * Every write is attributed to the **`system` actor**, which in this schema is
 * `role_changes.actor_user_id = null` — the platform itself acted. Not a sentinel user id: a
 * sentinel would be a row someone could sign in as, and "who made this person an admin" would have
 * a misleading answer rather than an honest one (FR-177).
 */

export const BOOTSTRAP_ADMINS_JOB_NAME = 'bootstrap-admins'

/**
 * Placeholder `google_subject` for a user created before they have ever signed in.
 *
 * The column is not null and unique because it is the stable IdP identifier, but a pre-authorised
 * row has no IdP identity yet. The prefix makes the placeholder recognisable, and keeps it in a
 * namespace no Google subject can collide with. Sign-in resolves a bootstrap row by its address —
 * `users.email` is `citext`, so case is not a second identity — and replaces both this value and
 * the placeholder display name with what the provider returned.
 */
export const BOOTSTRAP_GOOGLE_SUBJECT_PREFIX = 'bootstrap:'

/** Recorded on every `role_changes` row this job writes, so the trail says why. */
export const BOOTSTRAP_ROLE_CHANGE_REASON =
  'Bootstrap admin reconcile from SISYPHUS_BOOTSTRAP_ADMIN_EMAILS'

/** What this job needs from a database handle — satisfied by a pool or by a transaction. */
export type BootstrapWriter = Pick<SisyphusDatabase, 'insert' | 'select' | 'update'>

/** What the reconcile did about one address. All three flags false means it was already correct. */
export interface BootstrapAdminOutcome {
  readonly email: string
  readonly userId: string
  /** The user row did not exist and was created pre-authorised. */
  readonly created: boolean
  /** The role was not `admin` and now is. True for a newly created row as well. */
  readonly promoted: boolean
  /** The user was deactivated and has been reactivated — the zero-admins recovery path. */
  readonly reactivated: boolean
}

export interface BootstrapAdminsResult {
  readonly admins: readonly BootstrapAdminOutcome[]
  readonly created: number
  readonly promoted: number
  readonly reactivated: number
  /** Addresses that already held an active admin role. On a steady-state redeploy, all of them. */
  readonly unchanged: number
}

/**
 * Lower-case, trim and de-duplicate the configured addresses.
 *
 * The env schema already does the first two, so this is not a second parser — it is what makes the
 * reconcile safe to hand a hand-edited list. Two spellings of one address are one person, and
 * reconciling the same user twice in one transaction would write two `grant_admin` rows for a
 * single promotion.
 */
export const normaliseBootstrapEmails = (emails: readonly string[]): readonly string[] => {
  const seen = new Set<string>()

  for (const entry of emails) {
    const normalised = entry.trim().toLowerCase()
    if (normalised !== '') {
      seen.add(normalised)
    }
  }

  return [...seen]
}

interface ExistingUser {
  readonly id: string
  readonly role: User['role']
  readonly isActive: boolean
}

const findUserByEmail = async (
  writer: BootstrapWriter,
  email: string,
): Promise<ExistingUser | undefined> => {
  const rows = await writer
    .select({ id: users.id, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.email, email))
    .limit(1)

  return rows[0]
}

/** Append one `system`-actor row to the append-only role audit (FR-177). */
const recordSystemRoleChange = async (
  writer: BootstrapWriter,
  input: { readonly subjectUserId: string; readonly change: 'activate' | 'grant_admin' },
): Promise<void> => {
  await writer.insert(roleChanges).values({
    actorUserId: null,
    subjectUserId: input.subjectUserId,
    change: input.change,
    reason: BOOTSTRAP_ROLE_CHANGE_REASON,
  })
}

/**
 * Bring an existing row up to "active admin", writing a role change per distinct transition.
 *
 * Promotion and reactivation are recorded separately because they are separate events: a
 * deactivated admin who is restored has not been re-granted the role, and a trail that conflated
 * them would misdescribe what happened.
 */
const reconcileExistingUser = async (
  writer: BootstrapWriter,
  email: string,
  existing: ExistingUser,
): Promise<BootstrapAdminOutcome> => {
  const promoted = existing.role !== 'admin'
  const reactivated = !existing.isActive

  if (!promoted && !reactivated) {
    return { email, userId: existing.id, created: false, promoted: false, reactivated: false }
  }

  await writer.update(users).set({ role: 'admin', isActive: true }).where(eq(users.id, existing.id))

  if (promoted) {
    await recordSystemRoleChange(writer, { subjectUserId: existing.id, change: 'grant_admin' })
  }
  if (reactivated) {
    await recordSystemRoleChange(writer, { subjectUserId: existing.id, change: 'activate' })
  }

  return { email, userId: existing.id, created: false, promoted, reactivated }
}

/**
 * Create a pre-authorised admin for an address that has never signed in.
 *
 * `onConflictDoNothing` rather than a bare insert because two control-plane instances can run the
 * reconcile at once on a deploy. The loser of that race gets no row back and re-reads instead of
 * failing the whole deploy on a unique-violation.
 */
const createBootstrapUser = async (
  writer: BootstrapWriter,
  email: string,
): Promise<BootstrapAdminOutcome> => {
  const inserted = await writer
    .insert(users)
    .values({
      email,
      googleSubject: `${BOOTSTRAP_GOOGLE_SUBJECT_PREFIX}${email}`,
      displayName: email,
      role: 'admin',
      isActive: true,
    })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id })

  if (inserted.length === 0) {
    const raced = await findUserByEmail(writer, email)
    if (raced === undefined) {
      throw new Error(
        `Bootstrap admin ${email} could neither be created nor read back. The reconcile has not established an admin, so the deploy must fail rather than report success.`,
      )
    }
    return reconcileExistingUser(writer, email, raced)
  }

  const [row] = inserted
  await recordSystemRoleChange(writer, { subjectUserId: row.id, change: 'grant_admin' })

  return { email, userId: row.id, created: true, promoted: true, reactivated: false }
}

export interface ReconcileBootstrapAdminsOptions {
  readonly db: SisyphusDatabase
  /** Addresses from deploy-time configuration, in any case and with any duplicates. */
  readonly emails: readonly string[]
}

/**
 * Reconcile the configured addresses to active admins.
 *
 * One transaction for the whole list: a deploy either establishes the configured admins or leaves
 * the platform exactly as it found it. A half-applied reconcile is the ambiguous state this is
 * meant to remove, and the recovery for a failure is to run it again.
 *
 * Running it twice is a no-op — the second pass finds every address already an active admin,
 * writes nothing, and reports them as `unchanged`.
 */
export const reconcileBootstrapAdmins = async (
  options: ReconcileBootstrapAdminsOptions,
): Promise<BootstrapAdminsResult> => {
  const emails = normaliseBootstrapEmails(options.emails)

  if (emails.length === 0) {
    throw new Error(
      'The bootstrap admin list is empty. Without at least one address the platform has no admin and no configuration can be performed at all (FR-174).',
    )
  }

  const admins = await options.db.transaction(async (tx) => {
    const outcomes: BootstrapAdminOutcome[] = []

    for (const email of emails) {
      const existing = await findUserByEmail(tx, email)
      outcomes.push(
        existing === undefined
          ? await createBootstrapUser(tx, email)
          : await reconcileExistingUser(tx, email, existing),
      )
    }

    return outcomes
  })

  const count = (predicate: (outcome: BootstrapAdminOutcome) => boolean): number =>
    admins.filter(predicate).length

  return {
    admins,
    created: count((outcome) => outcome.created),
    promoted: count((outcome) => outcome.promoted),
    reactivated: count((outcome) => outcome.reactivated),
    unchanged: count((outcome) => !outcome.promoted && !outcome.reactivated),
  }
}

/** The reconcile wrapped in the uniform job envelope, for a caller that has its own handle. */
export const runBootstrapAdmins = (
  options: ReconcileBootstrapAdminsOptions,
): Promise<JobOutcome<BootstrapAdminsResult>> =>
  runJob(BOOTSTRAP_ADMINS_JOB_NAME, () => reconcileBootstrapAdmins(options))

/**
 * The deploy-time entry point: validated environment in, job outcome out.
 *
 * `../env` is imported dynamically and **inside** the handler for two reasons. Importing it at
 * module scope would validate the whole control-plane environment merely because something
 * imported this file — including in tests, which have no AWS configuration and need none to
 * exercise the reconcile. And doing it inside the handler means a missing or malformed
 * `SISYPHUS_BOOTSTRAP_ADMIN_EMAILS` surfaces as a job failure naming the variable rather than as an
 * unhandled rejection during module evaluation.
 *
 * The pooled client is deliberately not closed: it is the process-wide handle every other job
 * shares, and closing it here would take the pool away from whatever runs next.
 */
export const runBootstrapAdminsFromEnv = (): Promise<JobOutcome<BootstrapAdminsResult>> =>
  runJob(BOOTSTRAP_ADMINS_JOB_NAME, async () => {
    const { env } = await import('../env')
    const { db } = getDatabaseClient({ connectionString: env.DATABASE_URL })

    return reconcileBootstrapAdmins({ db, emails: env.SISYPHUS_BOOTSTRAP_ADMIN_EMAILS })
  })
