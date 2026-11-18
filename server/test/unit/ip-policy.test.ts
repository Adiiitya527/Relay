import { describe, expect, it } from 'vitest';
import { classifyAddress, isBlockedAddress } from '../../src/delivery/ip-policy.js';

describe('IPv4', () => {
  it.each([
    // [address, blocked]: both edges of every range that is easy to get wrong
    ['0.0.0.0', true],
    ['0.255.255.255', true],
    ['1.0.0.0', false],
    ['9.255.255.255', false],
    ['10.0.0.0', true],
    ['10.255.255.255', true],
    ['11.0.0.0', false],
    ['100.63.255.255', false],
    ['100.64.0.0', true],
    ['100.127.255.255', true],
    ['100.128.0.0', false],
    ['126.255.255.255', false],
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['128.0.0.0', false], // first address with the top bit set (signed-shift trap)
    ['169.254.169.254', true], // cloud metadata
    ['169.255.0.0', false],
    ['172.15.255.255', false],
    ['172.16.0.0', true],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    ['192.0.0.1', true],
    ['192.0.2.1', true],
    ['192.88.99.1', true],
    ['192.167.255.255', false],
    ['192.168.0.0', true],
    ['192.168.255.255', true],
    ['192.169.0.0', false],
    ['198.17.255.255', false],
    ['198.18.0.0', true],
    ['198.19.255.255', true],
    ['198.20.0.0', false],
    ['198.51.100.7', true],
    ['203.0.113.7', true],
    ['223.255.255.255', false],
    ['224.0.0.1', true],
    ['239.255.255.255', true],
    ['240.0.0.1', true],
    ['255.255.255.255', true],
    ['8.8.8.8', false],
    ['93.184.216.34', false],
  ])('%s → blocked %s', (ip, blocked) => {
    expect(isBlockedAddress(ip)).toBe(blocked);
  });
});

describe('IPv6', () => {
  it.each([
    ['::', true, 'unspecified'],
    ['::1', true, 'loopback'],
    ['[::1]', true, 'loopback'], // URL hostname form
    ['fe80::1', true, 'link-local'],
    ['fe80::1%eth0', true, 'link-local'], // zone id
    ['febf::1', true, 'link-local'],
    ['fc00::1', true, 'unique-local'],
    ['fdff:ffff::1', true, 'unique-local'],
    ['ff02::1', true, 'multicast'],
    ['100::1', true, 'not global unicast'], // discard prefix
    ['::7f00:1', true, 'not global unicast'], // deprecated IPv4-compatible
    ['2001:db8::1', true, 'documentation'],
    ['2001:0:4136:e378::1', true, 'Teredo tunnel'],
    ['2002:7f00:1::1', true, '6to4 tunnel'],
    ['2606:4700:4700::1111', false, 'global unicast IPv6'],
    ['2a00:1450:4001:80b::200e', false, 'global unicast IPv6'],
    ['3fff:ffff::1', false, 'global unicast IPv6'],
    ['4000::1', true, 'not global unicast'],
  ])('%s → blocked %s (%s)', (ip, blocked, reason) => {
    expect(classifyAddress(ip)).toEqual({ blocked, reason });
  });

  it.each([
    // IPv4-mapped: judged by the embedded IPv4
    ['::ffff:127.0.0.1', true, 'IPv4-mapped: loopback'],
    ['::ffff:7f00:1', true, 'IPv4-mapped: loopback'], // what new URL() produces
    ['[::ffff:7f00:1]', true, 'IPv4-mapped: loopback'],
    ['::FFFF:A9FE:A9FE', true, 'IPv4-mapped: link-local (cloud metadata)'],
    ['0:0:0:0:0:ffff:10.0.0.1', true, 'IPv4-mapped: private'],
    ['::ffff:8.8.8.8', false, 'IPv4-mapped: public IPv4'],
    // NAT64
    ['64:ff9b::a9fe:a9fe', true, 'NAT64: link-local (cloud metadata)'],
    ['64:ff9b::192.168.1.1', true, 'NAT64: private'],
    ['64:ff9b::808:808', false, 'NAT64: public IPv4'],
  ])('%s → blocked %s (%s)', (ip, blocked, reason) => {
    expect(classifyAddress(ip)).toEqual({ blocked, reason });
  });

  it('agrees with the URL parser: [::ffff:127.0.0.1] normalises to a blocked form', () => {
    const host = new URL('http://[::ffff:127.0.0.1]/').hostname;
    expect(host).toBe('[::ffff:7f00:1]');
    expect(isBlockedAddress(host)).toBe(true);
  });
});

describe('invalid input fails closed', () => {
  it.each(['', 'localhost', 'example.com', '256.0.0.1', '1.2.3', '::g', '1.2.3.4.5', ' 8.8.8.8'])(
    '%j is blocked',
    (input) => {
      expect(classifyAddress(input)).toEqual({ blocked: true, reason: 'not an IP address' });
    },
  );
});
