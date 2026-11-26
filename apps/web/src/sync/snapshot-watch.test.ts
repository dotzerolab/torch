import { describe, expect, it, vi } from 'vitest';
import type { ShapeKey } from './registry.ts';
import { createSnapshotWatch, MOUNT_STALE_MS } from './snapshot-watch.ts';

const ws = 'w1';
const labels: ShapeKey = { kind: 'labels', workspaceId: ws, teamId: 't1' };
const states: ShapeKey = { kind: 'workflowStates', workspaceId: ws, teamId: 't1' };
const otherTeam: ShapeKey = { kind: 'labels', workspaceId: ws, teamId: 't2' };
const workspaceLabels: ShapeKey = { kind: 'workspaceLabels', workspaceId: ws };

function setup() {
  let time = 1_000_000;
  const target = new EventTarget();
  const request = vi.fn<(key: ShapeKey, options?: { now?: boolean }) => void>();
  const watch = createSnapshotWatch({ request, now: () => time, target });
  return {
    watch,
    request,
    target,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('snapshot refresh triggers', () => {
  it('a screen opening a snapshot read less than a minute ago asks for nothing', () => {
    const { watch, request, advance } = setup();
    const release = watch.mount(labels);
    release();
    advance(MOUNT_STALE_MS - 1);
    watch.mount(labels);
    expect(request).not.toHaveBeenCalled();
  });

  it('a screen opening a snapshot read a minute ago or more refreshes it at once', () => {
    const { watch, request, advance } = setup();
    watch.mount(labels)();
    advance(MOUNT_STALE_MS);
    watch.mount(labels);
    expect(request).toHaveBeenCalledExactlyOnceWith(labels, { now: true });
    // The refresh renewed its age.
    advance(MOUNT_STALE_MS - 1);
    watch.mount(labels);
    expect(request).toHaveBeenCalledOnce();
  });

  it('workflow states are watched like the other snapshots', () => {
    const { watch, request, advance } = setup();
    watch.mount(states)();
    advance(MOUNT_STALE_MS);
    watch.mount(states);
    expect(request).toHaveBeenCalledExactlyOnceWith(states, { now: true });
  });

  it('coming back online refreshes every snapshot a screen holds, at once', () => {
    const { watch, request, target } = setup();
    watch.mount(labels);
    watch.mount(states);
    const gone = watch.mount(otherTeam);
    gone();
    target.dispatchEvent(new Event('online'));
    expect(request.mock.calls).toEqual([
      [labels, { now: true }],
      [states, { now: true }],
    ]);
  });

  it('a tab coming into focus asks for every snapshot a screen holds, within the gap', () => {
    const { watch, request, target } = setup();
    watch.mount(labels);
    target.dispatchEvent(new Event('focus'));
    expect(request).toHaveBeenCalledExactlyOnceWith(labels, { now: false });
  });

  it('a snapshot held by two screens stays watched until both leave', () => {
    const { watch, request, target } = setup();
    const a = watch.mount(labels);
    const b = watch.mount(labels);
    a();
    target.dispatchEvent(new Event('online'));
    expect(request).toHaveBeenCalledOnce();
    b();
    b();
    request.mockClear();
    target.dispatchEvent(new Event('online'));
    expect(request).not.toHaveBeenCalled();
  });

  it("this person's own write refreshes the team's snapshots at once, only the kinds named", () => {
    const { watch, request } = setup();
    watch.mount(labels);
    watch.mount(states);
    watch.mount(otherTeam);
    watch.mount(workspaceLabels);
    watch.ownWrite({ workspaceId: ws, teamId: 't1', kinds: ['labels'] });
    expect(request).toHaveBeenCalledExactlyOnceWith(labels, { now: true });
    request.mockClear();
    watch.ownWrite({ workspaceId: ws, teamId: 't1' });
    expect(request.mock.calls).toEqual([
      [labels, { now: true }],
      [states, { now: true }],
    ]);
  });

  it('an own write of the workspace refreshes the workspace snapshots', () => {
    const { watch, request } = setup();
    watch.mount(labels);
    watch.mount(workspaceLabels);
    watch.ownWrite({ workspaceId: ws, kinds: ['workspaceLabels'] });
    expect(request).toHaveBeenCalledExactlyOnceWith(workspaceLabels, { now: true });
  });

  it("a change of the team's live issues asks for the team's snapshots within the gap", () => {
    const { watch, request } = setup();
    watch.mount(labels);
    watch.mount(states);
    watch.mount(otherTeam);
    watch.mount(workspaceLabels);
    watch.issuesChanged(ws, 't1');
    expect(request.mock.calls).toEqual([
      [labels, { now: false }],
      [states, { now: false }],
    ]);
  });

  it('a snapshot of one issue is refreshed with its team', () => {
    const { watch, request } = setup();
    const detail: ShapeKey = { kind: 'issueDetail', workspaceId: ws, teamId: 't1', issueId: 'i1' };
    watch.mount(detail);
    watch.issuesChanged(ws, 't1');
    expect(request).toHaveBeenCalledExactlyOnceWith(detail, { now: false });
  });

  it('dispose stops listening', () => {
    const { watch, request, target } = setup();
    watch.mount(labels);
    watch.dispose();
    target.dispatchEvent(new Event('online'));
    expect(request).not.toHaveBeenCalled();
  });
});
