// The design system's public surface: import components, hooks and helpers from here, not from the files.
export { Avatar, type AvatarSize, avatarTone, initials } from './components/Avatar.tsx';
export { Badge, type BadgeTone } from './components/Badge.tsx';
export { Button, type ButtonProps, type ButtonVariant } from './components/Button.tsx';
export { Dialog } from './components/Dialog.tsx';
export { EmptyState } from './components/EmptyState.tsx';
export { IconButton, type IconButtonProps } from './components/IconButton.tsx';
export { Input, type InputProps } from './components/Input.tsx';
export { isMacPlatform, Kbd } from './components/Kbd.tsx';
export { Menu, type MenuItem } from './components/Menu.tsx';
export { Popover } from './components/Popover.tsx';
export { Select, type SelectOption } from './components/Select.tsx';
export { Skeleton } from './components/Skeleton.tsx';
export { Spinner } from './components/Spinner.tsx';
export { Textarea, type TextareaProps } from './components/Textarea.tsx';
export { type ToastInput, ToastProvider, useToast } from './components/Toast.tsx';
export { Tooltip } from './components/Tooltip.tsx';
export { LocaleProvider, useLocale, useT } from './locale.tsx';
export {
  applyTheme,
  getThemePreference,
  type ResolvedTheme,
  resolveTheme,
  setThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
  useTheme,
} from './theme.ts';
