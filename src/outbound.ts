import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

// Addresses Identity must not call on a team's behalf: loopback, private, link-local,
// carrier-grade NAT, unique-local and the unspecified and multicast ranges.
const internal = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  internal.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) {
  internal.addSubnet(network, prefix, 'ipv6');
}

export function internalAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const value = mapped ?? address;
  const family = isIP(value);
  return family === 0 || internal.check(value, family === 6 ? 'ipv6' : 'ipv4');
}

// True when every address the host resolves to is on the public internet.
export async function publicHost(hostname: string) {
  const name = hostname.replace(/^\[|\]$/g, '');
  if (isIP(name)) return !internalAddress(name);
  if (name === 'localhost' || name.endsWith('.localhost')) return false;
  try {
    const addresses = await lookup(name, { all: true });
    return addresses.length > 0 && addresses.every(({ address }) => !internalAddress(address));
  } catch { return false; }
}
