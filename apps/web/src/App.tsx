import type { Brand } from '@torch/shared/brand';
import { detectLocale, type Locale, t } from '@torch/shared/i18n';
import { readableForeground } from '@torch/shared/theme/contrast';
import { useEffect, useState } from 'react';
import { LoginPage } from './auth/LoginPage.tsx';
import { useSession } from './auth/useSession.ts';
import { VerifyPage } from './auth/VerifyPage.tsx';
import { navigate, usePathname } from './navigation.ts';
import { Workspace } from './screens/Workspace.tsx';
import { AppShell } from './shell/AppShell.tsx';

type State = { status: 'loading' } | { status: 'ready'; brand: Brand } | { status: 'error' };

async function fetchBrand(signal: AbortSignal): Promise<Brand> {
  const res = await fetch('/api/brand', { signal });
  if (!res.ok) throw new Error(`GET /api/brand failed with status ${res.status}`);
  return (await res.json()) as Brand;
}

function applyBrand(brand: Brand) {
  document.title = brand.productName;
  document.documentElement.style.setProperty('--accent', brand.accentColor);
  // The text on an accent surface flips to near-black when the brand's accent is pale.
  document.documentElement.style.setProperty('--accent-fg', readableForeground(brand.accentColor));
  let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!icon) {
    icon = document.createElement('link');
    icon.rel = 'icon';
    document.head.append(icon);
  }
  // The PNG fallbacks and the touch icon in index.html belong to the default brand: a custom favicon replaces them.
  if (icon.getAttribute('href') !== brand.favicon) {
    for (const el of document.querySelectorAll('[data-brand-default]')) el.remove();
    icon.removeAttribute('type');
  }
  icon.href = brand.favicon;
}

// `/` is the signed-in page: without a session it sends the visitor to /login.
function Home({ brand, locale }: { brand: Brand; locale: Locale }) {
  const session = useSession();
  useEffect(() => {
    if (session.status === 'signed-out') navigate('/login', { replace: true });
  }, [session.status]);

  if (session.status === 'loading' || session.status === 'signed-out')
    return <main aria-busy="true" />;
  if (session.status === 'error') {
    return <main role="alert">{t(locale, 'workspace.sessionError')}</main>;
  }
  return (
    <AppShell brand={brand} workspaces={session.workspaces} locale={locale}>
      <Workspace locale={locale} />
    </AppShell>
  );
}

export function App() {
  const locale = detectLocale(navigator.language);
  const pathname = usePathname();
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const controller = new AbortController();
    fetchBrand(controller.signal).then(
      (brand) => {
        applyBrand(brand);
        setState({ status: 'ready', brand });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        console.error(error);
        setState({ status: 'error' });
      },
    );
    return () => controller.abort();
  }, []);

  if (state.status === 'loading') return <main aria-busy="true" />;
  if (state.status === 'error') return <main role="alert">{t(locale, 'app.loadError')}</main>;

  if (pathname === '/login' || pathname === '/auth/verify') {
    return (
      <main>
        <h1 data-testid="app-title">
          {t(locale, 'app.welcome', { brand: state.brand.productName })}
        </h1>
        {pathname === '/login' ? (
          <LoginPage locale={locale} />
        ) : (
          <VerifyPage brand={state.brand} locale={locale} />
        )}
      </main>
    );
  }
  return <Home brand={state.brand} locale={locale} />;
}
