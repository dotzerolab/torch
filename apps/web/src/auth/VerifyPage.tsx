import type { Brand } from '@torch/shared/brand';
import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { ApiError, apiFetch } from '../api.ts';
import { navigate } from '../navigation.ts';
import { readLinkToken } from './link-token.ts';

type State =
  | { phase: 'reading' }
  | { phase: 'checking' }
  | { phase: 'ready'; email: string }
  | { phase: 'sending'; email: string }
  | { phase: 'invalid' }
  | { phase: 'unavailable' };

/**
 * The page the emailed link opens. The token is in the URL fragment: it is read once and removed from the address
 * bar at once, so it is not left in history, a bookmark or a screenshot. Showing the page consumes nothing (a mail
 * scanner that opens the link must not use it up): the server only says which email the link signs in, and the
 * token is spent when the person presses Continue. Naming the email is the defence against a link someone else
 * sent: the person sees whose account they are about to enter.
 */
export function VerifyPage({ brand, locale }: { brand: Brand; locale: Locale }) {
  const [state, setState] = useState<State>({ phase: 'reading' });
  // The token lives in memory only; it is never put back in the URL.
  const token = useRef<string | null>(null);
  // Counts the links taken from the address bar, so the answer of an older check never overwrites a newer one.
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
        const preview = await apiFetch<{ email: string }>('/api/auth/preview', {
          method: 'POST',
          body: JSON.stringify({ token: found }),
        });
        if (mine === generation.current) setState({ phase: 'ready', email: preview.email });
      } catch (error) {
        // 400: the link is used, expired or unknown. Anything else (rate limit, network, server): the link may
        // still be good, so do not tell the person it is not.
        if (mine === generation.current) {
          setState({
            phase: error instanceof ApiError && error.status === 400 ? 'invalid' : 'unavailable',
          });
        }
      }
    }

    void take();
    // Pasting the link again into this tab only changes the fragment: no reload, so listen for it.
    const onHashChange = () => {
      void take();
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  async function confirm() {
    if (state.phase !== 'ready' || token.current === null) return;
    const { email } = state;
    setState({ phase: 'sending', email });
    try {
      await apiFetch('/api/auth/verify', {
        method: 'POST',
        body: JSON.stringify({ token: token.current }),
      });
      token.current = null;
      navigate('/', { replace: true });
    } catch (error) {
      setState({
        phase: error instanceof ApiError && error.status === 400 ? 'invalid' : 'unavailable',
      });
    }
  }

  if (state.phase === 'reading' || state.phase === 'checking') {
    return (
      <section aria-busy="true">
        <h2>{t(locale, 'auth.verify.title')}</h2>
      </section>
    );
  }

  if (state.phase === 'invalid' || state.phase === 'unavailable') {
    return (
      <section>
        <h2>{t(locale, 'auth.verify.title')}</h2>
        <p role="alert" data-testid="verify-error">
          {t(locale, state.phase === 'invalid' ? 'auth.verify.invalid' : 'auth.verify.unavailable')}
        </p>
        <a
          href="/login"
          onClick={(event) => {
            event.preventDefault();
            navigate('/login');
          }}
        >
          {t(locale, 'auth.verify.requestNew')}
        </a>
      </section>
    );
  }

  return (
    <section>
      <h2>{t(locale, 'auth.verify.title')}</h2>
      <p>{t(locale, 'auth.verify.intro', { brand: brand.productName })}</p>
      <p data-testid="verify-email">
        {t(locale, 'auth.verify.signingInAs', { email: state.email })}
      </p>
      <button
        type="button"
        data-testid="verify-continue"
        disabled={state.phase === 'sending'}
        onClick={confirm}
      >
        {t(locale, 'auth.verify.continue')}
      </button>
    </section>
  );
}
