import { describe, expect, it, vi } from 'vitest';
import { forgetMyIssues } from './team-loss.ts';

const key = { kind: 'myIssues', workspaceId: 'w1' } as const;

describe('forgetMyIssues', () => {
  it('starts an open My Issues shape over: the restart removes the copy of the old instance', () => {
    const registry = { isOpen: vi.fn(() => true), restart: vi.fn() };
    const deleteCopy = vi.fn(async () => {});

    forgetMyIssues(registry, 'w1', deleteCopy);

    expect(registry.isOpen).toHaveBeenCalledWith(key);
    expect(registry.restart).toHaveBeenCalledWith(key);
    expect(deleteCopy).not.toHaveBeenCalled();
  });

  it('removes the copy on the device when the shape is not open on this page', () => {
    const registry = { isOpen: vi.fn(() => false), restart: vi.fn() };
    const deleteCopy = vi.fn(async () => {});

    forgetMyIssues(registry, 'w1', deleteCopy);

    expect(registry.restart).not.toHaveBeenCalled();
    expect(deleteCopy).toHaveBeenCalledWith('w1');
  });

  it('a copy that cannot be removed now is not an error of the page', async () => {
    const registry = { isOpen: () => false, restart: vi.fn() };

    expect(() =>
      forgetMyIssues(registry, 'w1', async () => {
        throw new Error('store closed');
      }),
    ).not.toThrow();
    await Promise.resolve();
  });
});
