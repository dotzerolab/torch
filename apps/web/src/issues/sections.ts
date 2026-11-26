// What a group of issues is called, and the colour of its dot: shared by the list's section headers and the board's
// column headers.

import type { TeamData } from './data.ts';
import type { Section } from './model/engine.ts';

export function sectionTitle(
  section: Section,
  data: Pick<TeamData, 'statesById' | 'membersById'>,
  names: ReadonlyMap<string, string> | undefined,
  t: (key: string, vars?: Record<string, string>) => string,
): { text: string; color?: string } {
  switch (section.group) {
    case 'state': {
      const state = section.id ? data.statesById.get(section.id) : undefined;
      return { text: state?.name ?? t('issues.section.otherState'), color: state?.color };
    }
    case 'stateType':
      return {
        text: section.id ? t(`issue.stateType.${section.id}`) : t('issues.section.otherState'),
      };
    case 'assignee':
      return {
        text: section.id
          ? (data.membersById.get(section.id)?.name ?? '')
          : t('picker.assignee.none'),
      };
    case 'priority':
      return { text: t(`issue.priority.${section.id}`) };
    case 'team':
      return { text: (section.id && names?.get(section.id)) || '' };
    default:
      return { text: '' };
  }
}
