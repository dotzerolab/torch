import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import { type FormEvent, useState } from 'react';
import { ApiError, apiFetch } from '../api.ts';

type State =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'sent'; email: string }
  | { status: 'error'; message: string };

function failureText(locale: Locale, error: unknown): string {
  if (error instanceof ApiError && error.code === 'invalid_email') {
    return t(locale, 'auth.login.invalidEmail');
  }
  if (error instanceof ApiError && error.status === 429) return t(locale, 'auth.login.rateLimited');
  return t(locale, 'auth.login.error');
}

export function LoginPage({ locale }: { locale: Locale }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>({ status: 'idle' });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setState({ status: 'sending' });
    try {
      await apiFetch<{ status: 'sent' }>('/api/auth/magic-link', {
        method: 'POST',
        body: JSON.stringify({ email, locale }),
      });
      setState({ status: 'sent', email: email.trim() });
    } catch (error) {
      setState({ status: 'error', message: failureText(locale, error) });
    }
  }

  if (state.status === 'sent') {
    return (
      <section>
        <h2>{t(locale, 'auth.login.title')}</h2>
        <p data-testid="login-sent" role="status">
          {t(locale, 'auth.login.sent', { email: state.email })}
        </p>
        <button type="button" onClick={() => setState({ status: 'idle' })}>
          {t(locale, 'auth.login.again')}
        </button>
      </section>
    );
  }

  return (
    <section>
      <h2>{t(locale, 'auth.login.title')}</h2>
      <form onSubmit={submit}>
        <label htmlFor="login-email">{t(locale, 'auth.login.emailLabel')}</label>
        <input
          id="login-email"
          data-testid="login-email"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" data-testid="login-submit" disabled={state.status === 'sending'}>
          {t(locale, state.status === 'sending' ? 'auth.login.sending' : 'auth.login.submit')}
        </button>
        {state.status === 'error' && (
          <p role="alert" data-testid="login-error">
            {state.message}
          </p>
        )}
      </form>
    </section>
  );
}
