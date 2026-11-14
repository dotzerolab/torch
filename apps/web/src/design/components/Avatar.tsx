import { useState } from 'react';
import { cx } from '../cx.ts';

export type AvatarSize = 'sm' | 'md' | 'lg';

const TONES = 8;

/** One to two capital letters: the first letters of the first and last word. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return '?';
  const last = words.length > 1 ? words[words.length - 1] : undefined;
  const letter = (word: string) => (Array.from(word)[0] ?? '').toUpperCase();
  return letter(first) + (last ? letter(last) : '');
}

/** A stable number from 1 to 8 for a name: the same person always gets the same colour. */
export function avatarTone(name: string): number {
  let hash = 5381;
  for (const char of name.trim().toLowerCase())
    hash = (hash * 33 + (char.codePointAt(0) ?? 0)) >>> 0;
  return (hash % TONES) + 1;
}

export function Avatar({
  name,
  src,
  size = 'md',
}: {
  name: string;
  src?: string;
  size?: AvatarSize;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      role="img"
      aria-label={name}
      className={cx('avatar', `avatar--${size}`, `avatar--${avatarTone(name)}`)}
    >
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
}
