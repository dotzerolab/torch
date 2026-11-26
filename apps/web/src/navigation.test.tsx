// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { navigate, useLocation } from './navigation.ts';

function Where() {
  const { pathname, search } = useLocation();
  return <p data-testid="where">{`${pathname}|${search}`}</p>;
}

beforeEach(() => window.history.replaceState({}, '', '/'));

describe('useLocation', () => {
  it('updates on pushState with a query', () => {
    render(<Where />);
    expect(screen.getByTestId('where')).toHaveTextContent('/|');
    act(() => navigate('/teams/ENG?group=assignee&order=due'));
    expect(screen.getByTestId('where')).toHaveTextContent('/teams/ENG|?group=assignee&order=due');
    expect(window.location.search).toBe('?group=assignee&order=due');
  });

  it('replace keeps the history where it was', () => {
    render(<Where />);
    act(() => navigate('/a'));
    const length = window.history.length;
    act(() => navigate('/b?x=1', { replace: true }));
    expect(window.history.length).toBe(length);
    expect(screen.getByTestId('where')).toHaveTextContent('/b|?x=1');
  });

  it('follows the back button', () => {
    render(<Where />);
    act(() => navigate('/a?x=1'));
    act(() => navigate('/b'));
    act(() => {
      window.history.back();
    });
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(screen.getByTestId('where')).toHaveTextContent('/a|?x=1');
        resolve();
      }, 50),
    );
  });
});
