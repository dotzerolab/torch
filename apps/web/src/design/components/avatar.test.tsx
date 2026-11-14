// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from './Avatar.tsx';

const tone = (element: HTMLElement) =>
  [...element.classList].find((name) => /^avatar--\d$/.test(name));

describe('Avatar', () => {
  it('shows the initials of a first and last name', () => {
    render(<Avatar name="Ada Lovelace" />);
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveTextContent('AL');
  });

  it('shows one letter for a single name and uses first and last of a long one', () => {
    const { rerender } = render(<Avatar name="ada" />);
    expect(screen.getByRole('img', { name: 'ada' })).toHaveTextContent('A');
    rerender(<Avatar name="Augusta Ada King Lovelace" />);
    expect(screen.getByRole('img', { name: 'Augusta Ada King Lovelace' })).toHaveTextContent('AL');
  });

  it('keeps the same colour for the same name across renders', () => {
    const { unmount } = render(<Avatar name="Grace Hopper" />);
    const first = tone(screen.getByRole('img'));
    unmount();
    render(<Avatar name="Grace Hopper" />);
    expect(tone(screen.getByRole('img'))).toBe(first);
    expect(first).toBeDefined();
  });

  it('can give different names different colours', () => {
    const names = [
      'Ada Lovelace',
      'Grace Hopper',
      'Alan Turing',
      'Edsger Dijkstra',
      'Barbara Liskov',
      'Donald Knuth',
    ];
    const seen = new Set(
      names.map((name) => {
        const { unmount } = render(<Avatar name={name} />);
        const value = tone(screen.getByRole('img'));
        unmount();
        return value;
      }),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it('draws the picture when there is one and falls back to initials when it fails', () => {
    render(<Avatar name="Ada Lovelace" src="/a.png" />);
    const image = document.querySelector('img');
    expect(image).toHaveAttribute('src', '/a.png');
    act(() => {
      image?.dispatchEvent(new Event('error'));
    });
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toHaveTextContent('AL');
  });
});
