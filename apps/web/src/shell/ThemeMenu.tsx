import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { IconButton } from '../design/components/IconButton.tsx';
import { Menu, type MenuItem } from '../design/components/Menu.tsx';
import { useT } from '../design/locale.tsx';
import { type ThemePreference, useTheme } from '../design/theme.ts';

const CHOICES: { value: ThemePreference; labelKey: string }[] = [
  { value: 'system', labelKey: 'shell.theme.system' },
  { value: 'light', labelKey: 'shell.theme.light' },
  { value: 'dark', labelKey: 'shell.theme.dark' },
];

/** System, light or dark: the choice is stored and wins over the operating system from then on. */
export function ThemeMenu() {
  const t = useT();
  const { preference, resolved, setPreference } = useTheme();
  const items: MenuItem[] = CHOICES.map(({ value, labelKey }) => ({
    id: value,
    label: t(labelKey),
    icon:
      preference === value ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <span className="menu__icon-gap" aria-hidden="true" />
      ),
    onSelect: () => setPreference(value),
  }));
  return (
    <Menu
      align="end"
      items={items}
      trigger={
        <IconButton
          label={t('shell.theme')}
          icon={
            preference === 'system' ? (
              <Monitor size={16} aria-hidden="true" />
            ) : resolved === 'dark' ? (
              <Moon size={16} aria-hidden="true" />
            ) : (
              <Sun size={16} aria-hidden="true" />
            )
          }
        />
      }
    />
  );
}
