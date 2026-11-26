import { useMemo } from 'react';
import { Avatar } from '../../design/components/Avatar.tsx';
import { useT } from '../../design/locale.tsx';
import type { SyncedMember } from '../../sync/collections.ts';
import { PropertyPicker } from './PropertyPicker.tsx';

const NONE = '__none__';
const ME = '__me__';

const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * No assignee, then Me, then the members by name. A deactivated member is offered only while the issue is still assigned
 * to them (so the current value is not blank and can be changed), marked as deactivated.
 */
export function AssigneePicker({
  members,
  meId,
  value,
  onChange,
  onClose,
}: {
  members: readonly SyncedMember[];
  meId: string;
  value: string | null;
  onChange: (memberId: string | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const options = useMemo(() => {
    const me = members.find((member) => member.id === meId);
    const others = members
      .filter(
        (member) => member.id !== meId && (member.deactivated_at === null || member.id === value),
      )
      .sort((a, b) => byName.compare(a.name, b.name));
    return [
      { id: NONE, label: t('picker.assignee.none') },
      ...(me
        ? [
            {
              id: ME,
              label: t('picker.assignee.me'),
              hint: me.name,
              icon: <Avatar name={me.name} size="sm" />,
            },
          ]
        : []),
      ...others.map((member) => ({
        id: member.id,
        label: member.name,
        hint: member.deactivated_at ? t('picker.assignee.deactivated') : undefined,
        icon: <Avatar name={member.name} size="sm" />,
      })),
    ];
  }, [members, meId, value, t]);
  const selected = value === null ? NONE : value === meId ? ME : value;
  return (
    <PropertyPicker
      label={t('picker.assignee')}
      options={options}
      selectedIds={[selected]}
      onPick={(option) => onChange(option.id === NONE ? null : option.id === ME ? meId : option.id)}
      onClose={onClose}
    />
  );
}
