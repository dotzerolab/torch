// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kbd } from './Kbd.tsx';

afterEach(() => vi.restoreAllMocks());

const keys = (container: HTMLElement) =>
  [...container.querySelectorAll('kbd')].map((element) => element.textContent);

describe('Kbd', () => {
  it('shows Cmd for mod on a Mac', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const { container } = render(<Kbd keys="mod+k" />);
    expect(keys(container)).toEqual(['Cmd', 'K']);
  });

  it('shows Ctrl for mod elsewhere', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    const { container } = render(<Kbd keys="mod+k" />);
    expect(keys(container)).toEqual(['Ctrl', 'K']);
  });

  it('shows a two-key sequence as two keys and a lone symbol as it is', () => {
    const { container, rerender } = render(<Kbd keys="g i" />);
    expect(keys(container)).toEqual(['G', 'I']);
    rerender(<Kbd keys="?" />);
    expect(keys(container)).toEqual(['?']);
  });
});
