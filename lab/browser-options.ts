import { hosts } from './fixtures.js';

export const browserArgs = [
  '--no-proxy-server',
  `--host-resolver-rules=${hosts.map((host) => `MAP ${host} 127.0.0.1`).join(', ')}`,
];
