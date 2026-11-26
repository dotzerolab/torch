import type { Locale } from '@torch/shared/i18n';
import { t } from '@torch/shared/i18n';
import { useLocation } from '../navigation.ts';
import { parseRoute } from '../routes.ts';
import { IssueListLegacy } from './IssueListLegacy.tsx';

/** The screen of the issue routes: a team's issues, one issue, My Issues. */
export function IssuesScreen({ locale }: { locale: Locale }) {
  const { pathname } = useLocation();
  const route = parseRoute(pathname);
  if (route.name === 'myIssues') {
    return <p className="issues__note">{t(locale, 'shell.myIssues')}</p>;
  }
  return <IssueListLegacy locale={locale} />;
}
