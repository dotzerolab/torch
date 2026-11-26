// A page for the end-to-end specs only: it mounts the components of the comments, files and documents screens inside the
// real shell, for the ids the address names, because the routes and screens that mount them belong to the issue UI. It is
// served by the dev server of the e2e stack and is not part of the build (`vite build` starts from `index.html` alone).
//   ?view=issue&team=<id>&issue=<id>[&archived=1]   comments and files of one issue
//   ?view=documents&team=<id>                       the documents of a team
//   ?view=document&team=<id>&doc=<id>               one document
import { detectLocale } from '@torch/shared/i18n';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AttachmentList } from '../../src/attachments/index.ts';
import { useSession } from '../../src/auth/useSession.ts';
import { CommentThread } from '../../src/comments/index.ts';
import { DocumentScreen, DocumentsScreen } from '../../src/documents/index.ts';
import '../../src/design/tokens.css';
import '../../src/design/base.css';
import '../../src/design/components/components.css';
import '../../src/screens/workspace.css';
import '../../src/settings/settings.css';
import '../../src/shell/shell.css';
import { applyTheme } from '../../src/design/theme.ts';
import { AppShell } from '../../src/shell/AppShell.tsx';
import { useShell } from '../../src/shell/ShellContext.ts';

applyTheme();

const query = () => new URLSearchParams(window.location.search);

function go(params: Record<string, string>) {
  window.history.pushState({}, '', `?${new URLSearchParams(params)}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function View() {
  const { workspace, teams, teamsReady } = useShell();
  const [, setTick] = useState(0);
  useEffect(() => {
    const update = () => setTick((tick) => tick + 1);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  const q = query();
  const team = teams.find((candidate) => candidate.id === q.get('team'));
  if (!teamsReady) return <p aria-busy="true" />;
  if (!team) return <p data-testid="harness-no-team">no team</p>;
  const view = q.get('view');
  if (view === 'issue') {
    const issueId = q.get('issue') ?? '';
    const readOnly = q.get('archived') === '1';
    return (
      <main data-testid="harness-issue">
        <CommentThread
          workspaceId={workspace.id}
          teamId={team.id}
          issueId={issueId}
          issueIdentifier="E2E-1"
          readOnly={readOnly}
        />
        <AttachmentList
          workspaceId={workspace.id}
          teamId={team.id}
          issueId={issueId}
          readOnly={readOnly}
        />
      </main>
    );
  }
  if (view === 'documents') {
    return (
      <DocumentsScreen
        workspaceId={workspace.id}
        team={team}
        onOpen={(doc) => go({ view: 'document', team: team.id, doc })}
      />
    );
  }
  if (view === 'document') {
    return (
      <DocumentScreen
        workspaceId={workspace.id}
        team={team}
        documentId={q.get('doc') ?? ''}
        onBack={() => go({ view: 'documents', team: team.id })}
      />
    );
  }
  return <p data-testid="harness-empty" />;
}

function Harness() {
  const locale = detectLocale(navigator.language);
  const session = useSession();
  const [brand, setBrand] = useState<Parameters<typeof AppShell>[0]['brand'] | null>(null);
  useEffect(() => {
    fetch('/api/brand')
      .then((res) => res.json())
      .then(setBrand);
  }, []);
  if (session.status !== 'signed-in' || !brand) return <main aria-busy="true" />;
  return (
    <AppShell brand={brand} workspaces={session.workspaces} locale={locale}>
      <View />
    </AppShell>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
