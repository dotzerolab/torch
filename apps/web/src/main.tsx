import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './design/tokens.css';
import './design/base.css';
import './design/components/components.css';
import './issues/issues.css';
import './settings/settings.css';
import './shell/shell.css';
import { applyTheme } from './design/theme.ts';

// The inline script in index.html set the first theme; this starts following the system setting.
applyTheme();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
