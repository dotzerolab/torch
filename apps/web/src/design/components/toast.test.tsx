// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from './Toast.tsx';

type Show = ReturnType<typeof useToast>['show'];

function Probe({ onReady }: { onReady: (show: Show) => void }) {
  onReady(useToast().show);
  return null;
}

function setup() {
  let show: Show = () => {};
  render(
    <ToastProvider>
      <Probe onReady={(next) => (show = next)} />
    </ToastProvider>,
  );
  return { show: (toast: Parameters<Show>[0]) => act(() => show(toast)) };
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('Toast', () => {
  it('announces an info message with role status and dismisses it after 6 seconds', () => {
    const { show } = setup();
    show({ message: 'Saved' });
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
    act(() => {
      vi.advanceTimersByTime(5900);
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('announces an error with role alert and keeps it until it is dismissed', async () => {
    const { show } = setup();
    show({ message: 'Could not save', tone: 'error' });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('runs the action and removes the toast', async () => {
    const onAction = vi.fn();
    const { show } = setup();
    show({ message: 'Issue archived', actionLabel: 'Undo', onAction });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
