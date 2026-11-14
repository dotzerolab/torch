import { detectLocale, type Locale, t } from '@torch/shared/i18n';
import { createContext, type ReactNode, useCallback, useContext } from 'react';

const LocaleContext = createContext<Locale | undefined>(undefined);

/** Gives the design components the language of the page; without one they follow the browser. */
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext) ?? detectLocale(navigator.language);
}

/** `t` bound to the current language, for the strings the components own (close, loading, ...). */
export function useT(): (key: string, vars?: Record<string, string>) => string {
  const locale = useLocale();
  return useCallback((key, vars) => t(locale, key, vars), [locale]);
}
