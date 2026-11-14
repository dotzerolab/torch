CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_member_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" NOT NULL,
	"locale" "locale" DEFAULT 'en' NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_member_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "invite_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "invite_email_normalised" CHECK ("invite"."email" = lower(btrim("invite"."email")))
);
--> statement-breakpoint
CREATE TABLE "invite_team" (
	"workspace_id" uuid NOT NULL,
	"invite_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "invite_team_invite_id_team_id_pk" PRIMARY KEY("invite_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_fk" FOREIGN KEY ("workspace_id","actor_member_id") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_invited_by_fk" FOREIGN KEY ("workspace_id","invited_by") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_accepted_member_fk" FOREIGN KEY ("workspace_id","accepted_member_id") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_team" ADD CONSTRAINT "invite_team_invite_fk" FOREIGN KEY ("workspace_id","invite_id") REFERENCES "public"."invite"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite_team" ADD CONSTRAINT "invite_team_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_workspace_created_idx" ON "audit_log" USING btree ("workspace_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "invite_token_hash_idx" ON "invite" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_pending_email_unique" ON "invite" USING btree ("workspace_id","email") WHERE "invite"."accepted_at" is null and "invite"."revoked_at" is null;