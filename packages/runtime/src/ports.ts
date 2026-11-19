/**
 * Free-port allocation for apps that run their own internal server (spec §14).
 *
 * Trick: bind a throwaway server to port 0 so the OS picks a free port, read it,
 * close the server, and hand that number to the app. There is a tiny race (someone
 * else could grab the port between close and the app's own bind), so apps should
 * fail fast if their bind fails.
 */
import net from 'node:net';

function probe(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Returns a free loopback port that is not in `avoid` (PiFi's own ports + ports already handed out). */
export async function allocatePort(avoid: ReadonlySet<number>): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await probe();
    if (port > 0 && !avoid.has(port)) return port;
  }
  throw new Error('could not find a free port');
}
