--
-- As generated, and checked. Three properties are worth stating, because none of them is visible
-- from the DDL alone (T200, FR-147, 003/FR-052).
--
-- 1. `scoped_credentials` is NOT TOUCHED, and that is the design decision rather than an omission.
--    A validation run has no workflow, so the alternative was to make `scoped_credentials`.
--    `workflow_id` nullable and rework `scoped_credentials_live_key` around it. That index is a
--    partial unique index on `(workflow_id) WHERE revoked_at is null` — at most one live credential
--    per run, which is what makes a re-mint supersede rather than duplicate and what makes the
--    previous instance's token recognisably dead rather than merely unexpired. Reworking a live
--    safety index so it can accommodate rows it was never written for is a change whose failure mode
--    is silent; leaving it alone is the strongest available proof that it was not weakened.
--    `src/db/schema/bundle.ts` argues the type-level half of the same choice.
--
-- 2. This is an APPEND, not a mid-order insert, and there is no ALTER TYPE anywhere in it. Unlike
--    0002 there is nothing here that PostgreSQL's 55P04 ("unsafe use of new value") can bite: no
--    enum gains a value, so the whole file is safe inside the single transaction
--    `run-migrations.ts` applies every outstanding migration in. `validation_outcome` moved in this
--    change from a literal array in `src/db/schema/enums.ts` to being generated from
--    `src/enums/validation-outcome.ts`, and that is deliberately a no-op for the database: the tuple
--    holds `('passed','failed')` in that order, which is exactly what 0000 created. `enums.test.ts`
--    compares the two, so a reordering would fail there rather than silently needing a migration
--    this file does not contain.
--
-- 3. No column here reaches the agent credential pool — no lease, no credential group, no seat
--    (003/FR-052). Proving a bundle must not consume pool capacity, and the way that is held is
--    that a validation credential has no column through which it could take a seat, rather than a
--    rule some allocator has to remember.
--
CREATE TABLE "validation_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"validation_run_id" uuid NOT NULL,
	"jti" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"renewal_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "validation_credentials" ADD CONSTRAINT "validation_credentials_validation_run_id_validation_runs_id_fk" FOREIGN KEY ("validation_run_id") REFERENCES "public"."validation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
--
-- A replayed token has to be recognisable rather than merely unexpired, which is what a fresh `jti`
-- per issue plus this index buys: the verifier looks the `jti` up and finds a revoked row, or no row
-- at all, and can say the credential was superseded.
--
CREATE UNIQUE INDEX "validation_credentials_jti_key" ON "validation_credentials" USING btree ("jti");--> statement-breakpoint
--
-- The counterpart to `scoped_credentials_live_key`, with the same shape and for the same reason: at
-- most one live credential per validation run, so a second mint for one run revokes the incumbent
-- inside its transaction rather than leaving two credentials one instance could present. Partial,
-- not a plain unique constraint — a run legitimately holds several credentials over its life and
-- only one of them may be live.
--
CREATE UNIQUE INDEX "validation_credentials_live_key" ON "validation_credentials" USING btree ("validation_run_id") WHERE "validation_credentials"."revoked_at" is null;
