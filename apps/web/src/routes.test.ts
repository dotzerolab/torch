import { describe, expect, it } from 'vitest';
import { parseRoute, routeTeamKey } from './routes.ts';

const GUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('parseRoute', () => {
  it('knows each screen', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/teams/ENG')).toEqual({ name: 'team', key: 'ENG' });
    expect(parseRoute(`/teams/ENG/views/${GUID}`)).toEqual({
      name: 'teamView',
      key: 'ENG',
      viewId: GUID,
    });
    expect(parseRoute('/issues/ENG-12')).toEqual({ name: 'issue', identifier: 'ENG-12' });
    expect(parseRoute('/my-issues')).toEqual({ name: 'myIssues' });
    expect(parseRoute('/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('/settings/profile')).toEqual({ name: 'settings' });
  });

  it('takes a trailing slash', () => {
    expect(parseRoute('/teams/ENG/')).toEqual({ name: 'team', key: 'ENG' });
    expect(parseRoute('/my-issues/')).toEqual({ name: 'myIssues' });
    expect(parseRoute('/issues/ENG-12/')).toEqual({ name: 'issue', identifier: 'ENG-12' });
  });

  it('reads the key from an encoded path', () => {
    expect(parseRoute('/teams/E%2DNG')).toEqual({ name: 'team', key: 'E-NG' });
  });

  it('sends what it does not know home', () => {
    for (const path of [
      '/nope',
      '/teams',
      '/teams/ENG/extra',
      '/teams/ENG/views',
      '/teams/ENG/views/not-a-guid',
      '/issues',
      '/issues/ENG',
      '/issues/ENG-x',
      '/issues/ENG-12/more',
      '/my-issues/x',
    ]) {
      expect(parseRoute(path)).toEqual({ name: 'home' });
    }
  });

  it('keeps the case of a view id the way the server stores it', () => {
    expect(parseRoute(`/teams/ENG/views/${GUID.toUpperCase()}`)).toEqual({
      name: 'teamView',
      key: 'ENG',
      viewId: GUID,
    });
  });
});

describe('routeTeamKey', () => {
  it('names the team a screen is about', () => {
    expect(routeTeamKey(parseRoute('/teams/ENG'))).toBe('ENG');
    expect(routeTeamKey(parseRoute(`/teams/OPS/views/${GUID}`))).toBe('OPS');
    expect(routeTeamKey(parseRoute('/issues/ENG-12'))).toBe('ENG');
    // A key may hold a dash itself; the number is what follows the last one.
    expect(routeTeamKey(parseRoute('/issues/A-B-7'))).toBe('A-B');
  });

  it('names no team for the rest', () => {
    expect(routeTeamKey(parseRoute('/'))).toBeNull();
    expect(routeTeamKey(parseRoute('/my-issues'))).toBeNull();
    expect(routeTeamKey(parseRoute('/settings/profile'))).toBeNull();
  });
});
