CREATE TYPE "public"."credential_release_reason" AS ENUM('terminal', 'forced', 'login_replaced');--> statement-breakpoint
CREATE TYPE "public"."credential_state" AS ENUM('awaiting_login', 'available', 'held', 'cooling_off', 'unhealthy', 'disabled');--> statement-breakpoint
--
-- As generated, and checked: this is a MID-ORDER INSERT, not an append (research R7). The order of
-- `bootstrap_phase` is the vocabulary — each phase has its own timeout and a hang is reported by
-- name — so appending `credential_install` would have placed credential installation after
-- `agent_start`, which is wrong and which no stored row would ever reveal. Safe in this
-- transaction because nothing below uses the new value; only `workflow_state` does, which is why
-- that one had to be handled differently.
--
ALTER TYPE "public"."bootstrap_phase" ADD VALUE 'credential_install' BEFORE 'entry_checkout';--> statement-breakpoint
--
-- HAND-EDITED. drizzle-kit generated:
--
--   ALTER TYPE "public"."workflow_state" ADD VALUE 'awaiting_credential' BEFORE 'provisioning';
--
-- which is the right change and the wrong statement. `run-migrations.ts` applies every outstanding
-- migration inside ONE transaction (drizzle's own migrator does this, deliberately, so a partly
-- applied schema is impossible), and PostgreSQL refuses to let a value added by ALTER TYPE ... ADD
-- VALUE be *used* before that transaction commits — error 55P04, "unsafe use of new value". The
-- last statement in this file is the partial index `WHERE state = 'awaiting_credential'`, which is
-- exactly such a use, so the generated form fails on every fresh database including CI's.
--
-- Splitting the index into a later migration would not help: on a database that has seen neither,
-- both still run in the same transaction. Recreating the type does work, because a type created
-- from scratch inside a transaction has no uncommitted values to be unsafe about.
--
-- The cost is real and worth stating: ALTER COLUMN ... SET DATA TYPE rewrites `workflows` and
-- `corrections` — the only two columns of this type — under an ACCESS EXCLUSIVE lock. A column of
-- this type added later and missed here would fail the DROP TYPE below rather than pass silently,
-- which is the safe direction. The alternative was to drop the partial
-- predicate from the queue index, which would have traded a one-off migration cost for a permanent
-- one on every write to the largest table in the schema.
--
-- The value order matches `src/enums/workflow-state.ts` exactly: `awaiting_credential` sits between
-- `queued` and `provisioning` because that is where admission puts it (003/FR-024, research R10).
-- `credential.test.ts` compares `enum_range(null::workflow_state)` against that tuple, so the two
-- cannot drift apart silently.
--
ALTER TYPE "public"."workflow_state" RENAME TO "workflow_state__pre_credential_pool";--> statement-breakpoint
CREATE TYPE "public"."workflow_state" AS ENUM('queued', 'awaiting_credential', 'provisioning', 'running', 'paused', 'parked_resumable', 'succeeded', 'failed', 'capped', 'cancelled', 'needs_attention');--> statement-breakpoint
ALTER TABLE "workflows" ALTER COLUMN "state" SET DATA TYPE "public"."workflow_state" USING "state"::text::"public"."workflow_state";--> statement-breakpoint
ALTER TABLE "corrections" ALTER COLUMN "workflow_state_at_submission" SET DATA TYPE "public"."workflow_state" USING "workflow_state_at_submission"::text::"public"."workflow_state";--> statement-breakpoint
DROP TYPE "public"."workflow_state__pre_credential_pool";--> statement-breakpoint
CREATE TABLE "agent_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"credential_group_id" uuid NOT NULL,
	"name" "citext" NOT NULL,
	"state" "credential_state" NOT NULL,
	"secret_id" text,
	"fence" bigint DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_exercised_at" timestamp with time zone,
	"held_by" text,
	"cooling_off_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"last_failure_reason" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" "citext" NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_leases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_credential_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"fence" bigint NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" "credential_release_reason",
	"released_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "keep_alive_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_credential_id" uuid NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "profile_credential_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"execution_profile_id" uuid NOT NULL,
	"credential_group_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "agent_credential_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_credential_group_id_credential_groups_id_fk" FOREIGN KEY ("credential_group_id") REFERENCES "public"."credential_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD CONSTRAINT "agent_credentials_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_groups" ADD CONSTRAINT "credential_groups_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_leases" ADD CONSTRAINT "credential_leases_agent_credential_id_agent_credentials_id_fk" FOREIGN KEY ("agent_credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_leases" ADD CONSTRAINT "credential_leases_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_leases" ADD CONSTRAINT "credential_leases_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keep_alive_runs" ADD CONSTRAINT "keep_alive_runs_agent_credential_id_agent_credentials_id_fk" FOREIGN KEY ("agent_credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_credential_groups" ADD CONSTRAINT "profile_credential_groups_execution_profile_id_execution_profiles_id_fk" FOREIGN KEY ("execution_profile_id") REFERENCES "public"."execution_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_credential_groups" ADD CONSTRAINT "profile_credential_groups_credential_group_id_credential_groups_id_fk" FOREIGN KEY ("credential_group_id") REFERENCES "public"."credential_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_credentials_name_key" ON "agent_credentials" USING btree ("name");--> statement-breakpoint
CREATE INDEX "agent_credentials_group_selection_idx" ON "agent_credentials" USING btree ("credential_group_id","state","last_used_at");--> statement-breakpoint
CREATE INDEX "agent_credentials_keep_alive_idx" ON "agent_credentials" USING btree ("state","last_exercised_at") WHERE "agent_credentials"."state" = 'available';--> statement-breakpoint
CREATE INDEX "agent_credentials_cooling_off_idx" ON "agent_credentials" USING btree ("state","cooling_off_until") WHERE "agent_credentials"."state" = 'cooling_off';--> statement-breakpoint
CREATE UNIQUE INDEX "credential_groups_name_key" ON "credential_groups" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_leases_live_key" ON "credential_leases" USING btree ("agent_credential_id") WHERE "credential_leases"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_leases_workflow_live_key" ON "credential_leases" USING btree ("workflow_id") WHERE "credential_leases"."released_at" is null;--> statement-breakpoint
CREATE INDEX "credential_leases_unreleased_idx" ON "credential_leases" USING btree ("released_at") WHERE "credential_leases"."released_at" is null;--> statement-breakpoint
CREATE INDEX "keep_alive_runs_credential_idx" ON "keep_alive_runs" USING btree ("agent_credential_id","ran_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "profile_credential_groups_position_key" ON "profile_credential_groups" USING btree ("execution_profile_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_credential_groups_group_key" ON "profile_credential_groups" USING btree ("execution_profile_id","credential_group_id");--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_agent_credential_id_agent_credentials_id_fk" FOREIGN KEY ("agent_credential_id") REFERENCES "public"."agent_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflows_awaiting_credential_idx" ON "workflows" USING btree ("state","created_at") WHERE "workflows"."state" = 'awaiting_credential';