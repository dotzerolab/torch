import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.ts';
import { toIssueUpdate } from './issue-update.ts';

const STATE = '8f1f2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

describe('toIssueUpdate', () => {
  it('maps the changed row columns to the update the server accepts', () => {
    expect(
      toIssueUpdate({ title: '  New title ', priority: 2, state_id: STATE, assignee_id: null }),
    ).toEqual({ title: 'New title', priority: 2, stateId: STATE, assigneeId: null });
  });

  it('sends only what changed', () => {
    expect(toIssueUpdate({ title: 'Only this' })).toEqual({ title: 'Only this' });
  });

  it('ignores columns the server does not let a client update', () => {
    expect(toIssueUpdate({ title: 'A', number: 99, team_id: STATE })).toEqual({ title: 'A' });
  });

  it('refuses an empty title with an invalid_input error and no request', () => {
    expect(() => toIssueUpdate({ title: '   ' })).toThrowError(ApiError);
    try {
      toIssueUpdate({ title: '   ' });
    } catch (error) {
      expect((error as ApiError).code).toBe('invalid_input');
    }
  });

  it('refuses a change with nothing to send', () => {
    expect(() => toIssueUpdate({ number: 99 })).toThrowError(ApiError);
  });
});
