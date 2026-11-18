import { isIP } from 'node:net';

/**
 * Which IP addresses Relay may connect to (SSRF protection, ARCHITECTURE §5, D44).
 *
 * IPv4: a BLOCK list of every special-purpose range (IANA registry): anything that is not
 * a routable public unicast address is refused.
 * IPv6: an ALLOW list. Only global unicast (2000::/3) is allowed, minus documentation,
 * 6to4 and Teredo (both tunnel to an embedded IPv4 we cannot vet). Everything else
 * (loopback, link-local, unique-local, multicast, …) is outside 2000::/3 and so blocked
 * without having to be listed.
 * Two IPv6 forms carry an IPv4 address and are judged by THAT address:
 *   ::ffff:a.b.c.d   IPv4-mapped (how the URL parser writes [::ffff:127.0.0.1]: ::ffff:7f00:1)
 *   64:ff9b::a.b.c.d NAT64 well-known prefix
 * Otherwise `http://[::ffff:127.0.0.1]/` would reach loopback.
 *
 * Pure: no DNS, no sockets. Unparseable input is blocked (fail closed).
 */

export interface IpVerdict {
  blocked: boolean;
  /** Human-readable reason, stored in the attempt's error_message when blocked. */
  reason: string;
}

// [network, prefix length, reason]
const IPV4_BLOCKED: ReadonlyArray<readonly [string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified ("this network")'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'carrier-grade NAT'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local (cloud metadata)'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'IETF protocol assignments'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.88.99.0', 24, '6to4 relay anycast'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmarking'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved / broadcast'], // includes 255.255.255.255
];

/** Dotted quad → unsigned 32-bit integer. Input must already pass isIP(…) === 4. */
function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

/** True if the 32-bit address lies in network/prefix. */
function inV4Range(addr: number, network: string, prefix: number): boolean {
  // Integer division instead of bit shifts: JS bit operators are signed 32-bit, so
  // `addr >> n` would go negative for addresses >= 128.0.0.0.
  const size = 2 ** (32 - prefix);
  return Math.floor(addr / size) === Math.floor(ipv4ToInt(network) / size);
}

function classifyV4Int(addr: number): IpVerdict {
  for (const [network, prefix, reason] of IPV4_BLOCKED) {
    if (inV4Range(addr, network, prefix)) return { blocked: true, reason };
  }
  return { blocked: false, reason: 'public IPv4' };
}

/**
 * IPv6 text → eight 16-bit groups. Handles "::" compression and a trailing dotted quad
 * (::ffff:1.2.3.4). Input must already pass isIP(…) === 6 (zone id stripped).
 */
function ipv6ToGroups(ip: string): number[] {
  let text = ip;
  // Rewrite a trailing dotted quad as two hex groups: ::ffff:1.2.3.4 → ::ffff:102:304
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const v4 = ipv4ToInt(last);
    text = `${text.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)));
  if (!text.includes('::')) return parse(text);
  // "::" stands for as many zero groups as are needed to make eight.
  const [head = '', tail = ''] = text.split('::');
  const left = parse(head);
  const right = parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

function classifyV6(ip: string): IpVerdict {
  const g = ipv6ToGroups(ip);
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) {
    return { blocked: true, reason: 'unparseable IPv6' };
  }
  const embeddedV4 = () => g[6]! * 65536 + g[7]!;

  // ::ffff:0:0/96 — IPv4-mapped
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    const v = classifyV4Int(embeddedV4());
    return { blocked: v.blocked, reason: `IPv4-mapped: ${v.reason}` };
  }
  // 64:ff9b::/96 — NAT64 well-known prefix
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const v = classifyV4Int(embeddedV4());
    return { blocked: v.blocked, reason: `NAT64: ${v.reason}` };
  }
  // Allow list: global unicast 2000::/3 = first group 0x2000–0x3fff.
  if (g[0]! < 0x2000 || g[0]! > 0x3fff) {
    if (g.every((x) => x === 0)) return { blocked: true, reason: 'unspecified' };
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return { blocked: true, reason: 'loopback' };
    if ((g[0]! & 0xffc0) === 0xfe80) return { blocked: true, reason: 'link-local' };
    if ((g[0]! & 0xfe00) === 0xfc00) return { blocked: true, reason: 'unique-local' };
    if ((g[0]! & 0xff00) === 0xff00) return { blocked: true, reason: 'multicast' };
    return { blocked: true, reason: 'not global unicast' };
  }
  if (g[0] === 0x2001 && g[1] === 0x0db8) return { blocked: true, reason: 'documentation' };
  if (g[0] === 0x2001 && g[1] === 0x0000) return { blocked: true, reason: 'Teredo tunnel' };
  if (g[0] === 0x2002) return { blocked: true, reason: '6to4 tunnel' };
  return { blocked: false, reason: 'global unicast IPv6' };
}

/** Accepts plain addresses and the bracketed form a URL hostname uses ([::1]). */
export function classifyAddress(input: string): IpVerdict {
  let ip = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  // A zone id (fe80::1%eth0) only appears on link-local addresses; drop it before parsing.
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);

  switch (isIP(ip)) {
    case 4:
      return classifyV4Int(ipv4ToInt(ip));
    case 6:
      return classifyV6(ip.toLowerCase());
    default:
      return { blocked: true, reason: 'not an IP address' };
  }
}

export function isBlockedAddress(input: string): boolean {
  return classifyAddress(input).blocked;
}
