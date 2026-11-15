CREATE TYPE "public"."activity_client" AS ENUM('web', 'api', 'mcp', 'import', 'system');--> statement-breakpoint
CREATE TABLE "event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid,
	"type" text NOT NULL,
	"version" smallint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"client" "activity_client" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_ref" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_ref_source_id_unique" UNIQUE("workspace_id","source","external_id"),
	CONSTRAINT "external_ref_subject_source_unique" UNIQUE("workspace_id","subject_type","subject_id","source"),
	CONSTRAINT "external_ref_source_format" CHECK ("external_ref"."source" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
	CONSTRAINT "external_ref_url_scheme" CHECK ("external_ref"."url" is null or "external_ref"."url" ~ '^https?://')
);
--> statement-breakpoint
CREATE TABLE "idempotency_key" (
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" smallint NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_key_workspace_id_actor_id_key_pk" PRIMARY KEY("workspace_id","actor_id","key"),
	CONSTRAINT "idempotency_key_length" CHECK (char_length("idempotency_key"."key") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "issue_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_id" uuid,
	"client" "activity_client" NOT NULL,
	"type" text NOT NULL,
	"field" text,
	"from_value" jsonb,
	"to_value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid,
	"name" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_view" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid,
	"owner_id" uuid,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"display" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_ref" ADD CONSTRAINT "external_ref_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."member"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_activity" ADD CONSTRAINT "issue_activity_issue_fk" FOREIGN KEY ("workspace_id","team_id","issue_id") REFERENCES "public"."issue"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_activity" ADD CONSTRAINT "issue_activity_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_template" ADD CONSTRAINT "issue_template_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_template" ADD CONSTRAINT "issue_template_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_owner_fk" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_workspace_occurred_idx" ON "event" USING btree ("workspace_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "idempotency_key_created_idx" ON "idempotency_key" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "issue_activity_issue_created_idx" ON "issue_activity" USING btree ("issue_id","created_at");