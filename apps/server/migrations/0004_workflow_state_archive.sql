ALTER TABLE "workflow_state" DROP CONSTRAINT "workflow_state_team_name_unique";--> statement-breakpoint
ALTER TABLE "workflow_state" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_state_team_name_unique" ON "workflow_state" USING btree ("team_id",lower("name")) WHERE "workflow_state"."archived_at" is null;