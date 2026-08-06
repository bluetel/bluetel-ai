-- Case-insensitive text for users.email: an address that differs only in case is the same
-- address, and comparing lower(email) in every query would make uniqueness a convention
-- rather than a constraint. Added by hand because drizzle-kit does not emit extensions.
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'executor', 'control_plane', 'reconciler', 'integration');--> statement-breakpoint
CREATE TYPE "public"."artifact_kind" AS ENUM('pull_request', 'diff', 'report', 'attachment');--> statement-breakpoint
CREATE TYPE "public"."bootstrap_phase" AS ENUM('provisioning', 'bundle_download', 'bundle_verify', 'bundle_unpack', 'setup_script', 'entry_checkout', 'agent_start');--> statement-breakpoint
CREATE TYPE "public"."bootstrap_phase_outcome" AS ENUM('succeeded', 'failed', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."claude_model" AS ENUM('claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-fable-5');--> statement-breakpoint
CREATE TYPE "public"."correction_delivery_outcome" AS ENUM('pending', 'delivered', 'failed', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."entry_result" AS ENUM('unchanged', 'landed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."external_action_kind" AS ENUM('pull_request_opened', 'comment_posted', 'ticket_transitioned', 'branch_pushed');--> statement-breakpoint
CREATE TYPE "public"."external_action_result" AS ENUM('succeeded', 'failed', 'pending');--> statement-breakpoint
CREATE TYPE "public"."integration_trigger" AS ENUM('scheduled', 'manual');--> statement-breakpoint
CREATE TYPE "public"."integration_type" AS ENUM('jira');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('slack_dm');--> statement-breakpoint
CREATE TYPE "public"."notification_event" AS ENUM('workflow_succeeded', 'workflow_failed', 'workflow_capped', 'workflow_cancelled', 'workflow_needs_attention', 'workflow_parked_resumable', 'review_iteration_failed', 'integration_tick_summary');--> statement-breakpoint
CREATE TYPE "public"."notification_outcome" AS ENUM('delivered', 'failed', 'unnotifiable');--> statement-breakpoint
CREATE TYPE "public"."purchase_mode" AS ENUM('spot', 'on_demand');--> statement-breakpoint
CREATE TYPE "public"."review_finding_severity" AS ENUM('blocker', 'major', 'minor', 'info');--> statement-breakpoint
CREATE TYPE "public"."review_verdict" AS ENUM('pass', 'fail');--> statement-breakpoint
CREATE TYPE "public"."role_change" AS ENUM('grant_admin', 'revoke_admin', 'activate', 'deactivate');--> statement-breakpoint
CREATE TYPE "public"."skill_name" AS ENUM('sisyphus-dev', 'sisyphus-review', 'sisyphus-integration');--> statement-breakpoint
CREATE TYPE "public"."snapshot_boundary" AS ENUM('completion', 'pause', 'interruption', 'stop');--> statement-breakpoint
CREATE TYPE "public"."supervision_command" AS ENUM('pause', 'resume', 'stop');--> statement-breakpoint
CREATE TYPE "public"."supervision_delivery_outcome" AS ENUM('pending', 'acknowledged', 'superseded', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."terminal_outcome" AS ENUM('succeeded', 'failed', 'capped', 'cancelled', 'needs_attention', 'parked_resumable');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('engineer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."validation_outcome" AS ENUM('passed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."workflow_event" AS ENUM('created', 'queued', 'admitted', 'provisioned', 'started', 'paused', 'corrected', 'resumed', 'snapshot_registered', 'interrupted', 'parked', 'capped', 'succeeded', 'failed', 'cancelled', 'needs_attention', 'access_denied', 'reassignment_required');--> statement-breakpoint
CREATE TYPE "public"."workflow_state" AS ENUM('queued', 'provisioning', 'running', 'paused', 'parked_resumable', 'succeeded', 'failed', 'capped', 'cancelled', 'needs_attention');--> statement-breakpoint
CREATE TYPE "public"."workflow_type" AS ENUM('delegated', 'autonomous', 'review');--> statement-breakpoint
CREATE TABLE "setup_bundle_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"setup_bundle_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"s3_key" text NOT NULL,
	"content_digest" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"registered_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "setup_bundles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"spend_caps_enforceable" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "validation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"setup_bundle_version_id" uuid NOT NULL,
	"outcome" "validation_outcome",
	"phase_results" jsonb,
	"output_s3_key" text,
	"triggered_by_user_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "profile_access_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"execution_profile_id" uuid NOT NULL,
	"granted_by_user_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "role_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"subject_user_id" uuid NOT NULL,
	"change" "role_change" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext" NOT NULL,
	"google_subject" text NOT NULL,
	"display_name" text NOT NULL,
	"role" "user_role" DEFAULT 'engineer' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"slack_user_id" text,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"integration_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"criteria" jsonb NOT NULL,
	"execution_profile_id" uuid NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"integration_id" uuid NOT NULL,
	"trigger" "integration_trigger" NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"examined_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"started_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"skip_reasons" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" "integration_type" NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"credential_secret_arn" text NOT NULL,
	"project_prefix" text NOT NULL,
	"label" text NOT NULL,
	"extra_filters" jsonb,
	"default_owner_user_id" uuid,
	"prompt_intro" text NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text NOT NULL,
	"per_tick_ceiling" integer NOT NULL,
	"rolling_period_ceiling" integer NOT NULL,
	"rolling_period_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"auto_disabled_reason" text,
	"schedule_arn" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"workflow_id" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "configuration_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_version" integer,
	"action" text NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"event" "notification_event" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid,
	"recipient_user_id" uuid NOT NULL,
	"event" "notification_event" NOT NULL,
	"channel" "notification_channel" DEFAULT 'slack_dm' NOT NULL,
	"outcome" "notification_outcome" NOT NULL,
	"coalesced_count" integer DEFAULT 1 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_watchers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_profile_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"execution_profile_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"workspace_version_id" uuid NOT NULL,
	"setup_bundle_version_id" uuid NOT NULL,
	"model" "claude_model" NOT NULL,
	"instance_type" text NOT NULL,
	"purchase_mode" "purchase_mode" DEFAULT 'spot' NOT NULL,
	"turn_cap" integer,
	"spend_cap" numeric(12, 4),
	"default_workflow_type" "workflow_type" NOT NULL,
	"prompt_preamble" text,
	"locked_fields" text[] DEFAULT '{}' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"current_version_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_version_id" uuid NOT NULL,
	"repository_url" text NOT NULL,
	"base_branch" text NOT NULL,
	"subdirectory" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"current_version_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"entry_id" uuid,
	"kind" "artifact_kind" NOT NULL,
	"s3_key" text,
	"external_url" text,
	"byte_size" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "log_segments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"s3_key" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"boundary" "snapshot_boundary" NOT NULL,
	"has_conversation_state" boolean NOT NULL,
	"has_worktree_state" boolean NOT NULL,
	"truncation_repaired" boolean DEFAULT false NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_references" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"skill_name" "skill_name" NOT NULL,
	"entry_id" uuid,
	"resolved_path" text,
	"content_digest" text,
	"phase" text,
	"unavailable_reason" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "corrections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"workflow_state_at_submission" "workflow_state" NOT NULL,
	"sequence" integer NOT NULL,
	"delivery_outcome" "correction_delivery_outcome" DEFAULT 'pending' NOT NULL,
	"delivered_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"kind" "external_action_kind" NOT NULL,
	"target_reference" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"result" "external_action_result" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iterations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"review_verdict" "review_verdict",
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "iterations_ordinal_bounds" CHECK ("iterations"."ordinal" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE "profile_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"field" text NOT NULL,
	"profile_value" text,
	"used_value" text NOT NULL,
	"set_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_findings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"iteration_id" uuid NOT NULL,
	"workflow_entry_id" uuid,
	"file_path" text,
	"line" integer,
	"severity" "review_finding_severity" NOT NULL,
	"summary" text NOT NULL,
	"resolved_in_iteration_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoped_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"jti" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"renewal_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "supervision_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"command" "supervision_command" NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"delivery_outcome" "supervision_delivery_outcome" DEFAULT 'pending' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bootstrap_phases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"phase" "bootstrap_phase" NOT NULL,
	"entry_id" uuid,
	"sequence" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" "bootstrap_phase_outcome",
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "compute_leases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"provider_instance_id" text,
	"instance_type" text NOT NULL,
	"purchase_mode" "purchase_mode" NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"release_reason" text
);
--> statement-breakpoint
CREATE TABLE "workflow_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workspace_entry_id" uuid NOT NULL,
	"repository_url" text NOT NULL,
	"base_branch" text NOT NULL,
	"subdirectory" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"resolved_commit" text,
	"was_changed" boolean DEFAULT false NOT NULL,
	"pull_request_url" text,
	"entry_result" "entry_result",
	"staleness_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"event" "workflow_event" NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_user_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" "workflow_type" NOT NULL,
	"state" "workflow_state" NOT NULL,
	"terminal_outcome" "terminal_outcome",
	"outcome_reason" text,
	"initiated_by_user_id" uuid,
	"originating_integration_id" uuid,
	"originating_mapping_id" uuid,
	"owner_user_id" uuid NOT NULL,
	"execution_profile_id" uuid,
	"execution_profile_version_id" uuid,
	"setup_bundle_version_id" uuid NOT NULL,
	"workspace_version_id" uuid NOT NULL,
	"ticket_reference" text,
	"result_branch_name" text,
	"assembled_prompt" text,
	"prompt_truncated" boolean DEFAULT false NOT NULL,
	"model" "claude_model" NOT NULL,
	"instance_type" text NOT NULL,
	"purchase_mode" "purchase_mode" NOT NULL,
	"turn_cap" integer,
	"spend_cap" numeric(12, 4),
	"turns_used" integer DEFAULT 0 NOT NULL,
	"spend_used" numeric(12, 4) DEFAULT '0' NOT NULL,
	"compute_cost_basis" numeric(12, 4),
	"predecessor_workflow_id" uuid,
	"session_id" uuid NOT NULL,
	"current_snapshot_id" uuid,
	"reviewer_summary" text,
	"needs_reassignment" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "setup_bundle_versions" ADD CONSTRAINT "setup_bundle_versions_setup_bundle_id_setup_bundles_id_fk" FOREIGN KEY ("setup_bundle_id") REFERENCES "public"."setup_bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_bundle_versions" ADD CONSTRAINT "setup_bundle_versions_registered_by_user_id_users_id_fk" FOREIGN KEY ("registered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_bundles" ADD CONSTRAINT "setup_bundles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_setup_bundle_version_id_setup_bundle_versions_id_fk" FOREIGN KEY ("setup_bundle_version_id") REFERENCES "public"."setup_bundle_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_runs" ADD CONSTRAINT "validation_runs_triggered_by_user_id_users_id_fk" FOREIGN KEY ("triggered_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_access_grants" ADD CONSTRAINT "profile_access_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_access_grants" ADD CONSTRAINT "profile_access_grants_execution_profile_id_execution_profiles_id_fk" FOREIGN KEY ("execution_profile_id") REFERENCES "public"."execution_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_access_grants" ADD CONSTRAINT "profile_access_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_access_grants" ADD CONSTRAINT "profile_access_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_changes" ADD CONSTRAINT "role_changes_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_changes" ADD CONSTRAINT "role_changes_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_mappings" ADD CONSTRAINT "integration_mappings_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_mappings" ADD CONSTRAINT "integration_mappings_execution_profile_id_execution_profiles_id_fk" FOREIGN KEY ("execution_profile_id") REFERENCES "public"."execution_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_runs" ADD CONSTRAINT "integration_runs_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_default_owner_user_id_users_id_fk" FOREIGN KEY ("default_owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_claims" ADD CONSTRAINT "ticket_claims_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_claims" ADD CONSTRAINT "ticket_claims_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "configuration_audit" ADD CONSTRAINT "configuration_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_watchers" ADD CONSTRAINT "workflow_watchers_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_watchers" ADD CONSTRAINT "workflow_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_profile_versions" ADD CONSTRAINT "execution_profile_versions_execution_profile_id_execution_profiles_id_fk" FOREIGN KEY ("execution_profile_id") REFERENCES "public"."execution_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_profile_versions" ADD CONSTRAINT "execution_profile_versions_workspace_version_id_workspace_versions_id_fk" FOREIGN KEY ("workspace_version_id") REFERENCES "public"."workspace_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_profile_versions" ADD CONSTRAINT "execution_profile_versions_setup_bundle_version_id_setup_bundle_versions_id_fk" FOREIGN KEY ("setup_bundle_version_id") REFERENCES "public"."setup_bundle_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_profile_versions" ADD CONSTRAINT "execution_profile_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_profiles" ADD CONSTRAINT "execution_profiles_current_version_id_execution_profile_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."execution_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_entries" ADD CONSTRAINT "workspace_entries_workspace_version_id_workspace_versions_id_fk" FOREIGN KEY ("workspace_version_id") REFERENCES "public"."workspace_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_versions" ADD CONSTRAINT "workspace_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_versions" ADD CONSTRAINT "workspace_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_current_version_id_workspace_versions_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."workspace_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_entry_id_workflow_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."workflow_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_segments" ADD CONSTRAINT "log_segments_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_snapshots" ADD CONSTRAINT "session_snapshots_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_references" ADD CONSTRAINT "skill_references_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_references" ADD CONSTRAINT "skill_references_entry_id_workflow_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."workflow_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_actions" ADD CONSTRAINT "external_actions_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iterations" ADD CONSTRAINT "iterations_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_overrides" ADD CONSTRAINT "profile_overrides_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_overrides" ADD CONSTRAINT "profile_overrides_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_iteration_id_iterations_id_fk" FOREIGN KEY ("iteration_id") REFERENCES "public"."iterations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_workflow_entry_id_workflow_entries_id_fk" FOREIGN KEY ("workflow_entry_id") REFERENCES "public"."workflow_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_resolved_in_iteration_id_iterations_id_fk" FOREIGN KEY ("resolved_in_iteration_id") REFERENCES "public"."iterations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoped_credentials" ADD CONSTRAINT "scoped_credentials_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_commands" ADD CONSTRAINT "supervision_commands_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supervision_commands" ADD CONSTRAINT "supervision_commands_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_phases" ADD CONSTRAINT "bootstrap_phases_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bootstrap_phases" ADD CONSTRAINT "bootstrap_phases_entry_id_workflow_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."workflow_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compute_leases" ADD CONSTRAINT "compute_leases_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_entries" ADD CONSTRAINT "workflow_entries_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_entries" ADD CONSTRAINT "workflow_entries_workspace_entry_id_workspace_entries_id_fk" FOREIGN KEY ("workspace_entry_id") REFERENCES "public"."workspace_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_events" ADD CONSTRAINT "workflow_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_originating_integration_id_integrations_id_fk" FOREIGN KEY ("originating_integration_id") REFERENCES "public"."integrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_originating_mapping_id_integration_mappings_id_fk" FOREIGN KEY ("originating_mapping_id") REFERENCES "public"."integration_mappings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_execution_profile_id_execution_profiles_id_fk" FOREIGN KEY ("execution_profile_id") REFERENCES "public"."execution_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_execution_profile_version_id_execution_profile_versions_id_fk" FOREIGN KEY ("execution_profile_version_id") REFERENCES "public"."execution_profile_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_setup_bundle_version_id_setup_bundle_versions_id_fk" FOREIGN KEY ("setup_bundle_version_id") REFERENCES "public"."setup_bundle_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_workspace_version_id_workspace_versions_id_fk" FOREIGN KEY ("workspace_version_id") REFERENCES "public"."workspace_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_predecessor_workflow_id_workflows_id_fk" FOREIGN KEY ("predecessor_workflow_id") REFERENCES "public"."workflows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_current_snapshot_id_session_snapshots_id_fk" FOREIGN KEY ("current_snapshot_id") REFERENCES "public"."session_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "setup_bundle_versions_version_key" ON "setup_bundle_versions" USING btree ("setup_bundle_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "setup_bundles_name_key" ON "setup_bundles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_access_grants_live_key" ON "profile_access_grants" USING btree ("user_id","execution_profile_id") WHERE "profile_access_grants"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_subject_key" ON "users" USING btree ("google_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_mappings_position_key" ON "integration_mappings" USING btree ("integration_id","position");--> statement-breakpoint
CREATE INDEX "integration_runs_integration_idx" ON "integration_runs" USING btree ("integration_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_name_key" ON "integrations" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_claims_external_key" ON "ticket_claims" USING btree ("integration_id","external_id");--> statement-breakpoint
CREATE INDEX "configuration_audit_entity_idx" ON "configuration_audit" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_event_key" ON "notification_preferences" USING btree ("user_id","event");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_workflow_idx" ON "notifications" USING btree ("workflow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_watchers_user_key" ON "workflow_watchers" USING btree ("workflow_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_profile_versions_version_key" ON "execution_profile_versions" USING btree ("execution_profile_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_profiles_name_key" ON "execution_profiles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_entries_subdirectory_key" ON "workspace_entries" USING btree ("workspace_version_id","subdirectory");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_entries_primary_key" ON "workspace_entries" USING btree ("workspace_version_id") WHERE "workspace_entries"."is_primary";--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_entries_position_key" ON "workspace_entries" USING btree ("workspace_version_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_versions_version_key" ON "workspace_versions" USING btree ("workspace_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_name_key" ON "workspaces" USING btree ("name");--> statement-breakpoint
CREATE INDEX "artifacts_workflow_kind_idx" ON "artifacts" USING btree ("workflow_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "log_segments_sequence_key" ON "log_segments" USING btree ("workflow_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "session_snapshots_current_key" ON "session_snapshots" USING btree ("workflow_id") WHERE "session_snapshots"."is_current";--> statement-breakpoint
CREATE INDEX "session_snapshots_workflow_idx" ON "session_snapshots" USING btree ("workflow_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "skill_references_workflow_idx" ON "skill_references" USING btree ("workflow_id","skill_name");--> statement-breakpoint
CREATE UNIQUE INDEX "corrections_sequence_key" ON "corrections" USING btree ("workflow_id","sequence");--> statement-breakpoint
CREATE INDEX "corrections_pending_idx" ON "corrections" USING btree ("workflow_id") WHERE "corrections"."delivery_outcome" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "external_actions_idempotency_key" ON "external_actions" USING btree ("workflow_id","kind","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "iterations_ordinal_key" ON "iterations" USING btree ("workflow_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_overrides_field_key" ON "profile_overrides" USING btree ("workflow_id","field");--> statement-breakpoint
CREATE INDEX "review_findings_iteration_idx" ON "review_findings" USING btree ("iteration_id","severity");--> statement-breakpoint
CREATE UNIQUE INDEX "scoped_credentials_jti_key" ON "scoped_credentials" USING btree ("jti");--> statement-breakpoint
CREATE UNIQUE INDEX "scoped_credentials_live_key" ON "scoped_credentials" USING btree ("workflow_id") WHERE "scoped_credentials"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "supervision_commands_sequence_key" ON "supervision_commands" USING btree ("workflow_id","sequence");--> statement-breakpoint
CREATE INDEX "supervision_commands_pending_idx" ON "supervision_commands" USING btree ("workflow_id") WHERE "supervision_commands"."delivery_outcome" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "bootstrap_phases_sequence_key" ON "bootstrap_phases" USING btree ("workflow_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "compute_leases_live_key" ON "compute_leases" USING btree ("workflow_id") WHERE "compute_leases"."released_at" is null;--> statement-breakpoint
CREATE INDEX "compute_leases_unreleased_idx" ON "compute_leases" USING btree ("released_at") WHERE "compute_leases"."released_at" is null;--> statement-breakpoint
CREATE INDEX "workflow_entries_repository_branch_idx" ON "workflow_entries" USING btree ("repository_url","base_branch");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_entries_workflow_entry_key" ON "workflow_entries" USING btree ("workflow_id","workspace_entry_id");--> statement-breakpoint
CREATE INDEX "workflow_events_workflow_idx" ON "workflow_events" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "workflows_profile_state_idx" ON "workflows" USING btree ("execution_profile_id","state","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflows_owner_state_idx" ON "workflows" USING btree ("owner_user_id","state");--> statement-breakpoint
CREATE INDEX "workflows_integration_idx" ON "workflows" USING btree ("originating_integration_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "workflows_predecessor_idx" ON "workflows" USING btree ("predecessor_workflow_id");