import { type Actor, canDeactivateMember, type Role } from '@torch/shared/permissions';
import { MoreHorizontal, UserCheck, UserX } from 'lucide-react';
import { Avatar } from '../design/components/Avatar.tsx';
import { Badge } from '../design/components/Badge.tsx';
import { IconButton } from '../design/components/IconButton.tsx';
import { Menu } from '../design/components/Menu.tsx';
import { Select } from '../design/components/Select.tsx';
import { useT } from '../design/locale.tsx';
import { roleChoices } from './access.ts';

/** One member as the table shows it: the synced profile and the email an admin may read. */
export type MemberRow = {
  id: string;
  name: string;
  handle: string;
  email: string;
  role: Role;
  deactivatedAt: string | null;
};

/**
 * The people of the workspace. Every control is offered only where the signed-in person may use it: the role select
 * lists the roles they can hand out (and is disabled on their own row and on rows they cannot change), the actions
 * menu exists only for rows they may deactivate or reactivate.
 */
export function MembersTable({
  rows,
  actor,
  onChangeRole,
  onToggleActive,
}: {
  rows: MemberRow[];
  actor: Actor;
  onChangeRole: (row: MemberRow, role: Role) => void;
  onToggleActive: (row: MemberRow) => void;
}) {
  const t = useT();
  return (
    <div className="table-wrap">
      <table className="table" data-testid="members-table">
        <thead>
          <tr>
            <th scope="col">{t('settings.members.name')}</th>
            <th scope="col">{t('settings.members.email')}</th>
            <th scope="col">{t('settings.members.role')}</th>
            <th scope="col">{t('settings.members.status')}</th>
            <th scope="col">
              <span className="visually-hidden">{t('common.moreActions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const target = { id: row.id, workspaceId: actor.workspaceId, role: row.role };
            const choices = roleChoices(actor, target);
            const deactivated = row.deactivatedAt !== null;
            const mayToggle = canDeactivateMember(actor, target);
            return (
              <tr
                key={row.id}
                data-testid={`member-row-${row.handle}`}
                data-deactivated={deactivated}
              >
                <td>
                  <span className="person">
                    <Avatar name={row.name} size="sm" />
                    <span className="person__name">{row.name}</span>
                    {row.id === actor.memberId ? <Badge>{t('settings.members.you')}</Badge> : null}
                  </span>
                </td>
                <td className="table__mono">{row.email}</td>
                <td>
                  <Select
                    label={t('settings.members.roleOf', { name: row.name })}
                    value={row.role}
                    disabled={!choices.editable}
                    options={choices.roles.map((role) => ({
                      value: role,
                      label: t(`settings.role.${role}`),
                    }))}
                    onValueChange={(role) => {
                      if (role !== row.role) onChangeRole(row, role as Role);
                    }}
                  />
                </td>
                <td>
                  {deactivated ? (
                    <Badge tone="warning">{t('settings.members.deactivated')}</Badge>
                  ) : (
                    <Badge tone="success">{t('settings.members.active')}</Badge>
                  )}
                </td>
                <td className="table__actions">
                  {mayToggle ? (
                    <Menu
                      align="end"
                      trigger={
                        <IconButton
                          label={t('settings.members.actionsFor', { name: row.name })}
                          icon={<MoreHorizontal size={16} aria-hidden="true" />}
                          tooltip={false}
                          size="sm"
                        />
                      }
                      items={[
                        {
                          id: 'toggle',
                          label: t(
                            deactivated
                              ? 'settings.members.reactivate'
                              : 'settings.members.deactivate',
                          ),
                          icon: deactivated ? (
                            <UserCheck size={14} aria-hidden="true" />
                          ) : (
                            <UserX size={14} aria-hidden="true" />
                          ),
                          danger: !deactivated,
                          onSelect: () => onToggleActive(row),
                        },
                      ]}
                    />
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
