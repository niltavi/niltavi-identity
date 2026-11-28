import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserApp, ProtocolPage } from './main';
import { routeFor } from './site';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing Identity application root.');

const { protocol: view, ...data } = root.dataset;
if (view === 'login' || view === 'register' || view === 'recover' || view === 'logout' || view === 'signed-out' || view === 'expired') {
  createRoot(root).render(<ProtocolPage data={{
    view, invalid: data.invalid === 'true', throttled: data.throttled === 'true', registration: data.registration, passwordless: data.passwordless === 'true',
    language: data.language === 'zh-CN' ? 'zh-CN' : 'en', appName: data.appName, appUrl: data.appUrl,
    signInName: data.signInName, signInLogoUrl: data.signInLogoUrl,
    interactionPath: data.interactionPath, loginPath: data.loginPath, recoverPath: data.recover,
    interactionSeconds: data.interactionSeconds ? Number(data.interactionSeconds) : undefined,
  }} />);
} else {
  // The prerendered markup knows the section only. The open tab is applied after hydration.
  const { language, section } = routeFor(window.location.pathname);
  const app = <BrowserApp initial={{ language, section }} origin={window.location.origin} />;
  if (root.hasAttribute('data-prerendered')) hydrateRoot(root, app);
  else createRoot(root).render(app);
}
