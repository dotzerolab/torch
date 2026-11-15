import type { Brand } from '@torch/shared/brand';
import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api.ts';
import { readLinkToken } from '../auth/link-token.ts';
import { Button } from '../design/components/Button.tsx';
import { Input } from '../design/components/Input.tsx';
import { LocaleProvider } from '../design/locale.tsx';
import { adminFailureMessage } from '../errors.ts';
import { navigate } from '../navigation.ts';
import { adminApi, type InvitePreview } from '../settings/admin-api.ts';

type State =
  | { phase: 'reading' }
  | { phase: 'checking' }
  | { phase: 'ready'; preview: InvitePreview; error: string | null }
  | { phase: 'accepting'; preview: InvitePreview }
  | { phase: 'invalid' }
  | { phase: 'unavailable' };

/**
 * The page the invitation email opens (`/invite#token=...`). Like the sign-in page, the token is read once from the
 * URL fragment and removed from the address bar at once, then kept in memory only. Showing the page spends nothing
 * (a mail scanner that opens the link must not use the invitation up): the server says who is invited and to what,
 * and the invitation is used when the person gives a name and presses the button.
 */
export function AcceptInvitePage({ brand, locale }: { brand: Brand; locale: Locale }) {
  const [state, setState] = useState<State>({ phase: 'reading' });
  const [name, setName] = useState('');
  const nameId = useId();
  const token = useRef<string | null>(null);
  // The answer of an older link never overwrites the answer for a newer one pasted into the same tab.
  const generation = useRef(0);

  useEffect(() => {
    async function take() {
      const found = readLinkToken(window.location.hash);
      if (window.location.hash !== '') {
        window.history.replaceState(null, '', window.location.pathname);
      }
      if (found === null) {
        // A remount (React runs every effect twice in development) finds the address bar already clean: that must
        // not discard a token already taken.
        if (token.current === null) setState({ phase: 'invalid' });
        return;
      }
      token.current = found;
      generation.current += 1;
      const mine = generation.current;
      setState({ phase: 'checking' });
      try {
        const preview = await adminApi.previewInvite(found);
        if (mine === generation.current) setState({ phase: 'ready', preview, error: null });
      } catch (error) {
        // The invitation is unknown, used, expired or revoked: 400. Anything else (rate limit, network, server) may
        // pass, so do not tell the person the link is bad.
        if (mine === generation.current) {
          setState({
            phase: error instanceof ApiError && error.status === 400 ? 'invalid' : 'unavailable',
          });
        }
      }
    }
    void take();
    const onHashChange = () => {
      void take();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  async function accept(event: FormEvent) {
    event.preventDefault();
    if (state.phase !== 'ready' || token.current === null || name.trim() === '') return;
    const { preview } = state;
    setState({ phase: 'accepting', preview });
    try {
      await adminApi.acceptInvite(token.current, name.trim());
      token.current = null;
      navigate('/', { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'invite_invalid') {
        setState({ phase: 'invalid' });
        return;
      }
      setState({ phase: 'ready', preview, error: adminFailureMessage(locale, error) });
    }
  }

  const title = t(locale, 'invite.title');
  if (state.phase === 'reading' || state.phase === 'checking') {
    return (
      <section className="invite" aria-busy="true">
        <h2>{title}</h2>
        <p>{t(locale, 'invite.checking')}</p>
      </section>
    );
  }
  if (state.phase === 'invalid' || state.phase === 'unavailable') {
    return (
      <section className="invite">
        <h2>{title}</h2>
        <p role="alert" data-testid="invite-invalid">
          {t(locale, state.phase === 'invalid' ? 'invite.invalid' : 'invite.unavailable')}
        </p>
        <a
          href="/login"
          onClick={(event) => {
            event.preventDefault();
            navigate('/login');
          }}
        >
          {t(locale, 'invite.toSignIn')}
        </a>
      </section>
    );
  }

  const { preview } = state;
  const accepting = state.phase === 'accepting';
  return (
    <LocaleProvider locale={locale}>
      <section className="invite" data-testid="invite-ready">
        <h2>{title}</h2>
        <p data-testid="invite-workspace">
          {t(locale, 'invite.intro', {
            workspace: preview.workspaceName,
            brand: brand.productName,
          })}
        </p>
        <p data-testid="invite-role">
          {t(locale, 'invite.role', { role: t(locale, `settings.role.${preview.role}`) })}
        </p>
        <p>{t(locale, 'invite.email', { email: preview.email })}</p>
        {preview.teams.length > 0 ? (
          <p data-testid="invite-teams">
            {t(locale, 'invite.teams', {
              teams: preview.teams.map((team) => team.name).join(', '),
            })}
          </p>
        ) : null}
        <form className="form" onSubmit={accept} noValidate>
          <div className="form__row">
            <label className="form__label" htmlFor={nameId}>
              {t(locale, 'invite.nameLabel')}
            </label>
            <Input
              id={nameId}
              value={name}
              maxLength={80}
              autoComplete="name"
              disabled={accepting}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {state.phase === 'ready' && state.error ? (
            <p className="form__error" role="alert" data-testid="invite-accept-error">
              {state.error}
            </p>
          ) : null}
          <div className="form__actions">
            <Button
              type="submit"
              variant="primary"
              loading={accepting}
              disabled={name.trim() === ''}
              data-testid="invite-accept"
            >
              {accepting ? t(locale, 'invite.accepting') : t(locale, 'invite.accept')}
            </Button>
          </div>
        </form>
      </section>
    </LocaleProvider>
  );
}
