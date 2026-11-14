import { cx } from '../cx.ts';

/** True on Apple platforms, where `mod` is the Command key. */
export function isMacPlatform(): boolean {
  return /mac|iphone|ipad|ipod/i.test(navigator.platform ?? '');
}

function keyLabel(key: string, mac: boolean): string {
  switch (key.toLowerCase()) {
    case 'mod':
      return mac ? 'Cmd' : 'Ctrl';
    case 'meta':
      return 'Cmd';
    case 'ctrl':
      return 'Ctrl';
    case 'alt':
      return mac ? 'Option' : 'Alt';
    case 'shift':
      return 'Shift';
    case 'enter':
      return 'Enter';
    case 'esc':
    case 'escape':
      return 'Esc';
    case 'space':
      return 'Space';
    case 'up':
      return '↑';
    case 'down':
      return '↓';
    case 'left':
      return '←';
    case 'right':
      return '→';
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

/**
 * A shortcut as key caps. `mod+k` is one chord (`mod` is Cmd on a Mac, Ctrl elsewhere); `g i` is a sequence, two
 * steps typed one after the other.
 */
export function Kbd({ keys, className }: { keys: string; className?: string }) {
  const mac = isMacPlatform();
  const steps = keys.trim().split(/\s+/);
  return (
    <span className={cx('kbd-group', className)}>
      {steps.map((step, stepIndex) => (
        // The shortcut is a fixed string, so position is a stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
        <span className="kbd-step" key={stepIndex}>
          {step.split('+').map((key) => (
            <kbd key={key}>{keyLabel(key, mac)}</kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
