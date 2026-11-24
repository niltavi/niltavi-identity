import { ArrowRotateLeft } from '@gravity-ui/icons';
import { Alert, Button, Card, Checkbox, Chip, Label } from '@heroui/react';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initialState } from '../contract.js';
import type { AppEvidence, Command, PreviewState } from '../contract.js';
import './theme/index.css';
import './preview.css';

const summaries: Record<PreviewState['outcome'], string> = {
  ready: 'Sign in to App A, then open App B.',
  'a-signed-in': 'App A granted access. Open App B in the same test browser to check session reuse.',
  'b-reused-session': 'App B granted access without another sign-in prompt.',
  'b-needs-login': 'App B reached the sign-in prompt. Sign in to App A to establish a central session.',
  'logged-out': 'Both applications received the signed logout notification and denied access.',
  'logout-receiver-unavailable': 'App B missed the logout notification. Its next access check still returned HTTP 401.',
};

function ApplicationCard({ name, evidence }: { name: string; evidence: AppEvidence }) {
  const status = evidence.httpStatus === 200 ? 'Signed in' : evidence.httpStatus === 401 ? 'Access denied' : 'Unchecked';
  return (
    <article aria-label={name}>
      <Card className="identity-preview__card">
        <Card.Header className="identity-preview__card-header">
          <Card.Title render={(props) => <h2 {...props} />}>{name}</Card.Title>
          <Chip color={evidence.httpStatus === 200 ? 'success' : 'default'} variant="soft">
            <Chip.Label>{status}</Chip.Label>
          </Chip>
        </Card.Header>
        <Card.Content>
          <dl className="identity-preview__facts">
            <div><dt>Protected endpoint</dt><dd>{evidence.httpStatus === null ? 'Awaiting check' : `HTTP ${evidence.httpStatus}`}</dd></div>
            <div><dt>Account subject</dt><dd>{evidence.sub ?? '—'}</dd></div>
            <div><dt>Signed logout receipts</dt><dd>{evidence.logoutReceipts}</dd></div>
          </dl>
        </Card.Content>
      </Card>
    </article>
  );
}

function responseError(body: unknown) {
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
    ? body.error : 'The preview executor could not complete the request.';
}

function Preview() {
  const [state, setState] = useState(initialState);
  const [pending, setPending] = useState<Command['action'] | 'connect' | null>('connect');
  const [simulateUnavailableB, setSimulateUnavailableB] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/status', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Could not read the preview executor’s status.');
      setState(await response.json() as PreviewState);
    }).catch(() => {
      if (!controller.signal.aborted) setError('Could not connect to the preview executor.');
    }).finally(() => {
      if (!controller.signal.aborted) setPending(null);
    });
    return () => controller.abort();
  }, []);

  async function run(command: Command) {
    setPending(command.action);
    setError(null);
    try {
      const response = await fetch('/api/action', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setError(responseError(body));
      } else {
        setState(body as PreviewState);
        if (command.action === 'reset') setSimulateUnavailableB(false);
      }
    } catch {
      setError('The preview executor stopped responding.');
    } finally {
      setPending(null);
    }
  }

  const busy = pending !== null;
  const aReady = state.a.httpStatus === 200;
  const bReady = state.b.httpStatus === 200;
  return (
    <main className="identity-preview">
      <header className="identity-preview__header">
        <div>
          <p className="identity-preview__context">Niltavi Identity</p>
          <h1>Single sign-on check</h1>
          <p className="identity-preview__intro">Check sign-in and global logout across two apps using a test account.</p>
        </div>
        <Button variant="ghost" size="sm" isDisabled={busy} onPress={() => { void run({ action: 'reset' }); }}>
          <ArrowRotateLeft aria-hidden="true" width={16} height={16} /> Reset
        </Button>
      </header>

      <section className="identity-preview__apps" aria-label="Application status">
        <ApplicationCard name="App A" evidence={state.a} />
        <ApplicationCard name="App B" evidence={state.b} />
      </section>

      <section className="identity-preview__controls" aria-label="Session actions" aria-busy={busy}>
        <div className="identity-preview__actions">
          <Button variant={aReady ? 'secondary' : 'primary'} isDisabled={busy || aReady} onPress={() => {
            void run({ action: 'sign-in-a' });
          }}>Sign in to App A</Button>
          <Button variant={aReady && !bReady ? 'primary' : 'secondary'} isDisabled={busy || bReady} onPress={() => {
            void run({ action: 'open-b' });
          }}>Open App B</Button>
          <Button variant={aReady && bReady ? 'primary' : 'secondary'} isDisabled={busy || !aReady || !bReady} onPress={() => {
            void run({ action: 'logout', simulateUnavailableB });
          }}>Sign out of all apps</Button>
        </div>
        <Checkbox isSelected={simulateUnavailableB} isDisabled={busy || !bReady} onChange={setSimulateUnavailableB}>
          <Checkbox.Content>
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            <Label>Make App B’s logout receiver unavailable</Label>
          </Checkbox.Content>
        </Checkbox>
      </section>

      <section className="identity-preview__result" aria-label="Run result">
        {error && <Alert status="danger"><Alert.Indicator /><Alert.Content><Alert.Description>{error}</Alert.Description></Alert.Content></Alert>}
        <p aria-live="polite">{busy ? 'Waiting for the test browser…' : summaries[state.outcome]}</p>
        <p className="identity-preview__prompts">Central sign-in prompts <strong>{state.loginPrompts}</strong></p>
      </section>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('The preview mount point is missing.');
const preference = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  document.documentElement.dataset.theme = preference.matches ? 'dark' : 'light';
}
applyTheme();
preference.addEventListener('change', applyTheme);
createRoot(root).render(<Preview />);
