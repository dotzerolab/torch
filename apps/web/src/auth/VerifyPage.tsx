import type { Brand } from '@torch/shared/brand';
import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import { useState } from 'react';
import { apiFetch } from '../api.ts';
import { navigate } from '../navigation.ts';

/**
 * The page the emailed link opens. Showing it consumes nothing: a mail scanner that fetches the link must not use
 * it up, so the token is sent only when the person presses Continue.
 */
export function VerifyPage({ brand, locale }: { brand: Brand; locale: Locale }) {
  const token = new URLSearchParams(window.location.search).get('token');
  const [state, setState] = useState<'ready' | 'sending' | 'invalid'>(token ? 'ready' : 'invalid');

  async function confirm() {
    setState('sending');
    try {
      await apiFetch('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) });
      navigate('/', { replace: true });
    } catch {
      setState('invalid');
    }
  }

  if (state === 'invalid') {
    return (
      <section>
        <h2>{t(locale, 'auth.verify.title')}</h2>
        <p role="alert" data-testid="verify-error">
          {t(locale, 'auth.verify.invalid')}
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
      <button
        type="button"
        data-testid="verify-continue"
        disabled={state === 'sending'}
        onClick={confirm}
      >
        {t(locale, 'auth.verify.continue')}
      </button>
    </section>
  );
}
