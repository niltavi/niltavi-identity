import { fileURLToPath } from 'node:url';
import serveStatic from '@fastify/static';
import Fastify from 'fastify';
import type { Command, PreviewState } from './contract.js';
import { createRunner } from './runner.js';

const host = '127.0.0.1';
const port = Number(process.env.IDENTITY_PREVIEW_PORT ?? '4187');
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('IDENTITY_PREVIEW_PORT must be an unprivileged TCP port.');
}
const address = `${host}:${port}`;
const origin = `http://${address}`;
const runner = createRunner();
const app = Fastify({ bodyLimit: 1_024 });
let activeCommand: Promise<PreviewState> | undefined;

app.addHook('onRequest', async (request, reply) => {
  if (request.headers.host !== address) {
    return reply.code(421).send({ error: 'Use the reported loopback address.' });
  }
});
app.get('/api/status', (_request, reply) => reply.header('cache-control', 'no-store').send(runner.read()));
app.post<{ Body: Command }>('/api/action', {
  schema: {
    body: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { enum: ['sign-in-a', 'open-b', 'logout', 'reset'] },
        simulateUnavailableB: { type: 'boolean' },
      },
    },
  },
}, async (request, reply) => {
  if (request.headers.origin !== origin) {
    return reply.code(403).send({ error: 'Open the preview from its loopback address.' });
  }
  if (activeCommand) {
    return reply.code(409).send({ error: 'The test browser is already processing an action.' });
  }
  if (request.body.action === 'logout') {
    const state = runner.read();
    if (state.a.httpStatus !== 200 || state.b.httpStatus !== 200) {
      return reply.code(409).send({ error: 'Sign in to both applications first.' });
    }
  }
  activeCommand = runner.execute(request.body);
  try {
    return reply.header('cache-control', 'no-store').send(await activeCommand);
  } catch (error) {
    console.error('Identity preview action failed:', request.body.action, error instanceof Error ? error.name : 'Error');
    return reply.code(503).send({
      error: 'The browser could not complete the action. Check PostgreSQL and Playwright, then reset the run.',
    });
  } finally {
    activeCommand = undefined;
  }
});

app.addHook('onClose', async () => {
  await activeCommand?.catch(() => undefined);
  await runner.close();
});
await app.register(serveStatic, { root: fileURLToPath(new URL('./dist/', import.meta.url)) });
await app.listen({ host, port });
console.log(`Niltavi Identity preview listening on ${origin}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().catch(() => { process.exitCode = 1; });
  });
}
