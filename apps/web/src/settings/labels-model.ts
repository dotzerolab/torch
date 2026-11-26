// The labels of one scope laid out the way the screen lists them: groups with their labels, then the labels that are in
// no group. Archived labels are history (their chips stay on issues) and are not listed.
import type { SyncedLabel } from '../sync/collections.ts';
import type { LabelDto } from './admin-api.ts';

export type LabelTree = {
  groups: { group: SyncedLabel; children: SyncedLabel[] }[];
  loose: SyncedLabel[];
};

const byName = (a: SyncedLabel, b: SyncedLabel) => a.name.localeCompare(b.name);

export function labelTree(rows: readonly SyncedLabel[]): LabelTree {
  const open = rows.filter((row) => row.archived_at === null);
  const groups = open.filter((row) => row.is_group).sort(byName);
  const groupIds = new Set(groups.map((group) => group.id));
  const labels = open.filter((row) => !row.is_group);
  return {
    groups: groups.map((group) => ({
      group,
      children: labels.filter((label) => label.parent_id === group.id).sort(byName),
    })),
    // A label whose group is archived (or gone) shows with the loose ones.
    loose: labels
      .filter((label) => !label.parent_id || !groupIds.has(label.parent_id))
      .sort(byName),
  };
}

/** The synced row a server answer stands for. */
export function labelRow(dto: LabelDto, workspaceId: string): SyncedLabel {
  return {
    id: dto.id,
    workspace_id: workspaceId,
    team_id: dto.teamId,
    parent_id: dto.parentId,
    name: dto.name,
    color: dto.color,
    is_group: dto.isGroup,
    archived_at: dto.archivedAt,
    created_at: dto.createdAt,
  };
}
