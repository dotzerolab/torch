CREATE TABLE "attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "attachment_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "attachment_size_range" CHECK ("attachment"."size_bytes" between 1 and 26214400),
	CONSTRAINT "attachment_file_name_length" CHECK (char_length("attachment"."file_name") between 1 and 200),
	CONSTRAINT "attachment_status_known" CHECK ("attachment"."status" in ('pending', 'ready')),
	CONSTRAINT "attachment_ready_at_matches_status" CHECK (("attachment"."status" = 'ready') = ("attachment"."ready_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "comment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"parent_id" uuid,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"reactions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "comment_workspace_issue_id_unique" UNIQUE("workspace_id","issue_id","id"),
	CONSTRAINT "comment_reactions_object" CHECK (jsonb_typeof("comment"."reactions") = 'object'),
	CONSTRAINT "comment_parent_not_self" CHECK ("comment"."parent_id" <> "comment"."id"),
	CONSTRAINT "comment_resolve_roots_only" CHECK ("comment"."resolved_at" is null or "comment"."parent_id" is null),
	CONSTRAINT "comment_body_length" CHECK (char_length("comment"."body") <= 20000)
);
--> statement-breakpoint
CREATE TABLE "comment_edit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"comment_id" uuid NOT NULL,
	"body" text NOT NULL,
	"edited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "document_workspace_team_id_unique" UNIQUE("workspace_id","team_id","id"),
	CONSTRAINT "document_title_length" CHECK (char_length("document"."title") between 1 and 255),
	CONSTRAINT "document_body_length" CHECK (char_length("document"."body") <= 100000)
);
--> statement-breakpoint
CREATE TABLE "document_revision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"edited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_issue_fk" FOREIGN KEY ("workspace_id","team_id","issue_id") REFERENCES "public"."issue"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_uploader_fk" FOREIGN KEY ("workspace_id","uploader_id") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_issue_fk" FOREIGN KEY ("workspace_id","team_id","issue_id") REFERENCES "public"."issue"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_parent_fk" FOREIGN KEY ("workspace_id","issue_id","parent_id") REFERENCES "public"."comment"("workspace_id","issue_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_author_fk" FOREIGN KEY ("workspace_id","author_id") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment" ADD CONSTRAINT "comment_resolved_by_fk" FOREIGN KEY ("workspace_id","resolved_by") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_edit" ADD CONSTRAINT "comment_edit_issue_fk" FOREIGN KEY ("workspace_id","team_id","issue_id") REFERENCES "public"."issue"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_edit" ADD CONSTRAINT "comment_edit_comment_fk" FOREIGN KEY ("workspace_id","issue_id","comment_id") REFERENCES "public"."comment"("workspace_id","issue_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_edit" ADD CONSTRAINT "comment_edit_editor_fk" FOREIGN KEY ("workspace_id","edited_by") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."team"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document" ADD CONSTRAINT "document_updated_by_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_document_fk" FOREIGN KEY ("workspace_id","team_id","document_id") REFERENCES "public"."document"("workspace_id","team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_revision" ADD CONSTRAINT "document_revision_editor_fk" FOREIGN KEY ("workspace_id","edited_by") REFERENCES "public"."member"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachment_issue_idx" ON "attachment" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "attachment_status_created_idx" ON "attachment" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "comment_issue_created_idx" ON "comment" USING btree ("issue_id","created_at","id");--> statement-breakpoint
CREATE INDEX "comment_edit_comment_created_idx" ON "comment_edit" USING btree ("comment_id","created_at","id");--> statement-breakpoint
CREATE INDEX "document_team_updated_idx" ON "document" USING btree ("team_id","updated_at");--> statement-breakpoint
CREATE INDEX "document_revision_document_created_idx" ON "document_revision" USING btree ("document_id","created_at","id");