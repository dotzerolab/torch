CREATE TYPE "public"."issue_relation_type" AS ENUM('blocks', 'related', 'duplicate');--> statement-breakpoint
CREATE TABLE "issue_label" (
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	CONSTRAINT "issue_label_issue_id_label_id_pk" PRIMARY KEY("issue_id","label_id")
);
--> statement-breakpoint
CREATE TABLE "issue_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_link_url_scheme" CHECK ("issue_link"."url" ~ '^https?://')
);
--> statement-breakpoint
CREATE TABLE "issue_relation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"related_team_id" uuid NOT NULL,
	"related_issue_id" uuid NOT NULL,
	"type" "issue_relation_type" NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_relation_unique" UNIQUE("issue_id","related_issue_id","type"),
	CONSTRAINT "issue_relation_not_self" CHECK ("issue_relation"."issue_id" <> "issue_relation"."related_issue_id")
);
--> statement-breakpoint
CREATE TABLE "issue_subscriber" (
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_subscriber_issue_id_member_id_pk" PRIMARY KEY("issue_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "label" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid,
	"parent_id" uuid,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"is_group" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "label_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "label_parent_not_self" CHECK ("label"."parent_id" <> "label"."id")
);
--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "estimate" smallint;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "sort_order" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_workspace_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_workspace_team_id_unique" UNIQUE("workspace_id","team_id","id");--> statement-breakpoint
ALTER TABLE "issue_label" ADD CONSTRAINT "issue_label_issue_fk" FOREIGN KEY ("workspace_id","team_id","issue_id") REFERENCES "public"."issue"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_label" ADD CONSTRAINT "issue_label_label_fk" FOREIGN KEY ("workspace_id","label_id") REFERENCES "public"."label"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_link" ADD CONSTRAINT "issue_link_issue_fk" FOREIGN KEY ("workspace_id","team_id","issue_id") REFERENCES "public"."issue"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_link" ADD CONSTRAINT "issue_link_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relation" ADD CONSTRAINT "issue_relation_issue_fk" FOREIGN KEY ("workspace_id","team_id","issue_id") REFERENCES "public"."issue"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relation" ADD CONSTRAINT "issue_relation_related_fk" FOREIGN KEY ("workspace_id","related_team_id","related_issue_id") REFERENCES "public"."issue"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_relation" ADD CONSTRAINT "issue_relation_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_subscriber" ADD CONSTRAINT "issue_subscriber_issue_fk" FOREIGN KEY ("workspace_id","team_id","issue_id") REFERENCES "public"."issue"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_subscriber" ADD CONSTRAINT "issue_subscriber_member_fk" FOREIGN KEY ("workspace_id","member_id") REFERENCES "public"."member"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label" ADD CONSTRAINT "label_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label" ADD CONSTRAINT "label_parent_fk" FOREIGN KEY ("workspace_id","parent_id") REFERENCES "public"."label"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_label_team_idx" ON "issue_label" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "issue_label_label_idx" ON "issue_label" USING btree ("label_id");--> statement-breakpoint
CREATE INDEX "issue_link_team_idx" ON "issue_link" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "issue_link_issue_idx" ON "issue_link" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_relation_team_idx" ON "issue_relation" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "issue_relation_related_idx" ON "issue_relation" USING btree ("related_team_id","related_issue_id");--> statement-breakpoint
CREATE INDEX "issue_subscriber_team_idx" ON "issue_subscriber" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "label_scope_name_unique" ON "label" USING btree ("workspace_id",coalesce("team_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name")) WHERE "label"."archived_at" is null;--> statement-breakpoint
CREATE INDEX "label_team_idx" ON "label" USING btree ("team_id");--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_parent_fk" FOREIGN KEY ("workspace_id","parent_id") REFERENCES "public"."issue"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_workspace_updated_idx" ON "issue" USING btree ("workspace_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "issue_parent_idx" ON "issue" USING btree ("parent_id");--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_estimate_range" CHECK ("issue"."estimate" between 0 and 64);--> statement-breakpoint
ALTER TABLE "issue" ADD CONSTRAINT "issue_parent_not_self" CHECK ("issue"."parent_id" <> "issue"."id");