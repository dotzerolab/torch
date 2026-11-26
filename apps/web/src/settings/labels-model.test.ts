import { describe, expect, it } from 'vitest';
import type { SyncedLabel } from '../sync/collections.ts';
import { labelTree } from './labels-model.ts';

const label = (id: string, extra: Partial<SyncedLabel> = {}): SyncedLabel => ({
  id,
  workspace_id: 'w',
  team_id: null,
  parent_id: null,
  name: id,
  color: '#222222',
  is_group: false,
  archived_at: null,
  created_at: '2026-11-01T00:00:00Z',
  ...extra,
});

describe('labelTree', () => {
  it('puts the labels of a group under it and the others in the loose list, each by name', () => {
    const tree = labelTree([
      label('Zeta'),
      label('Area', { is_group: true }),
      label('Beta', { parent_id: 'Area' }),
      label('Alpha', { parent_id: 'Area' }),
      label('Gamma'),
    ]);
    expect(tree.groups.map((g) => [g.group.id, g.children.map((c) => c.id)])).toEqual([
      ['Area', ['Alpha', 'Beta']],
    ]);
    expect(tree.loose.map((l) => l.id)).toEqual(['Gamma', 'Zeta']);
  });

  it('leaves archived labels out, and lists a label of an archived group as loose', () => {
    const tree = labelTree([
      label('Gone', { archived_at: '2026-11-02T00:00:00Z' }),
      label('Old group', { is_group: true, archived_at: '2026-11-02T00:00:00Z' }),
      label('Child', { parent_id: 'Old group' }),
    ]);
    expect(tree.groups).toEqual([]);
    expect(tree.loose.map((l) => l.id)).toEqual(['Child']);
  });
});
