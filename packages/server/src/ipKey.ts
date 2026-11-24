/**
 * The key used for per-IP limits (Phase 3 Part A).
 *
 * IPv4: the address itself. IPv6: the /64 prefix, because one home or phone
 * usually owns a whole /64 and can pick any of its 2^64 addresses at will.
 * Keying per address would make every per-IP limit trivial to dodge.
 */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1] as string;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
  const groups = expandIpv6(ip);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip;
}

/** "2001:db8::1" -> ["2001","db8","0","0","0","0","0","1"]; undefined if not IPv6. */
function expandIpv6(ip: string): string[] | undefined {
  const addr = ip.split('%')[0] as string; // drop a zone id like fe80::1%eth0
  if (!addr.includes(':')) return undefined;
  const [head, tail, ...rest] = addr.split('::');
  if (rest.length > 0) return undefined; // more than one "::"
  const left = head ? head.split(':') : [];
  const right = tail !== undefined ? (tail ? tail.split(':') : []) : undefined;
  if (right === undefined) return left.length === 8 ? left.map(norm) : undefined;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return undefined;
  return [...left, ...Array(missing).fill('0'), ...right].map(norm);
}

const norm = (g: string): string => (g.replace(/^0+(?=.)/, '') || '0').toLowerCase();
