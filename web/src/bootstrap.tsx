import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserApp, ProtocolPage } from './main';
import { routeFor } from './site';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing Identity application root.');

const screen = root.dataset.protocol;
if (screen === 'login' || screen === 'logout' || screen === 'signed-out') {
  createRoot(root).render(<ProtocolPage view={screen} invalid={root.dataset.invalid === 'true'} registration={root.dataset.registration} />);
} else {
  const app = <BrowserApp initial={routeFor(window.location.pathname)} />;
  if (root.hasAttribute('data-prerendered')) hydrateRoot(root, app);
  else createRoot(root).render(app);
}
