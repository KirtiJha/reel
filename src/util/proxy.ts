import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import type { Duplex } from "node:stream";

/**
 * Reaching the outside world from inside a corporate network.
 *
 * Node does not honour `HTTPS_PROXY` on its own — `curl` does, which is why a
 * request can time out from a tool while the same URL fetches fine from the
 * shell next to it. On a managed laptop, direct outbound to a vendor is usually
 * refused and everything is expected to go through a proxy, so a TTS endpoint
 * that works everywhere else fails with a bare connect timeout and no
 * explanation.
 *
 * This is a `CONNECT` tunnel and nothing more: open a socket to the proxy, ask
 * it to join us to the origin, then run TLS over the result. Written out rather
 * than taken as a dependency — it is fifty lines, and this package has kept its
 * dependency list to the things that genuinely cannot be written here.
 */

/** Proxy for a target URL, honouring the usual environment variables. */
export function proxyForUrl(target: URL): URL | null {
  const isHttps = target.protocol === "https:";
  const raw =
    (isHttps ? process.env.HTTPS_PROXY ?? process.env.https_proxy : undefined) ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy;
  if (!raw?.trim()) return null;
  if (bypassesProxy(target.hostname)) return null;
  try {
    // A proxy given as `host:port` is common and is not a valid URL on its own.
    return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
}

/**
 * Whether `NO_PROXY` exempts this host.
 *
 * Entries match a whole host or any subdomain of it, with or without a leading
 * dot, and `*` exempts everything. Ports and CIDR blocks that appear in real
 * NO_PROXY values are ignored rather than half-honoured: treating `10.0.0.0/8`
 * as a hostname would silently never match, and pretending otherwise would be
 * worse than being plainly conservative.
 */
export function bypassesProxy(hostname: string): boolean {
  const raw = process.env.NO_PROXY ?? process.env.no_proxy;
  if (!raw?.trim()) return false;
  const host = hostname.toLowerCase();
  for (const entryRaw of raw.split(",")) {
    const entry = entryRaw.trim().toLowerCase().replace(/:\d+$/, "");
    if (!entry) continue;
    if (entry === "*") return true;
    const bare = entry.startsWith(".") ? entry.slice(1) : entry;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

export interface TunnelOptions {
  ca?: Buffer;
  rejectUnauthorized: boolean;
  timeoutMs: number;
}

/**
 * An https.Agent that reaches the origin through a `CONNECT` tunnel.
 *
 * Plugged in where a plain agent would go, so the request code above it does
 * not have to know whether a proxy is involved.
 */
export class ProxyTunnelAgent extends https.Agent {
  constructor(
    private readonly proxy: URL,
    private readonly opts: TunnelOptions,
  ) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: https.AgentOptions & { host?: string; port?: number; servername?: string },
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null {
    const host = options.host ?? "";
    const port = options.port ?? 443;
    const proxyPort = Number(this.proxy.port) || (this.proxy.protocol === "https:" ? 443 : 80);

    const socket = net.connect(proxyPort, this.proxy.hostname);
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      callback?.(err, undefined as unknown as Duplex);
    };

    socket.setTimeout(this.opts.timeoutMs, () =>
      fail(new Error(`Timed out connecting to proxy ${this.proxy.host}`)),
    );
    socket.once("error", (err) =>
      fail(new Error(`Could not reach proxy ${this.proxy.host}: ${err.message}`)),
    );

    socket.once("connect", () => {
      const auth = this.proxy.username
        ? "Proxy-Authorization: Basic " +
          Buffer.from(
            `${decodeURIComponent(this.proxy.username)}:${decodeURIComponent(this.proxy.password)}`,
          ).toString("base64") +
          "\r\n"
        : "";
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          auth +
          "Connection: keep-alive\r\n\r\n",
      );
    });

    // The proxy's reply is a bare HTTP response; everything after the blank
    // line belongs to the tunnel, so parsing stops at the first CRLFCRLF.
    let head = "";
    const onData = (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        // A proxy that answers with something enormous is not answering CONNECT.
        if (head.length > 16_384) fail(new Error("Proxy sent an unreadable CONNECT response"));
        return;
      }
      socket.removeListener("data", onData);
      const status = Number(/^HTTP\/\d\.\d (\d+)/.exec(head)?.[1] ?? 0);
      if (status !== 200) {
        const line = head.split("\r\n")[0] ?? "";
        fail(
          new Error(
            status === 407
              ? `Proxy ${this.proxy.host} requires authentication (407). ` +
                "Include credentials in HTTPS_PROXY, e.g. http://user:pass@host:port"
              : `Proxy ${this.proxy.host} refused the tunnel: ${line}`,
          ),
        );
        return;
      }
      // Anything the proxy sent past the blank line is already tunnel traffic;
      // pushing it back means TLS sees the stream from its true beginning.
      const rest = Buffer.from(head.slice(end + 4), "latin1");
      if (rest.length) socket.unshift(rest);

      socket.setTimeout(0);
      const secure = tls.connect({
        socket,
        servername: options.servername ?? host,
        ca: this.opts.ca,
        rejectUnauthorized: this.opts.rejectUnauthorized,
      });
      secure.once("error", (err) => fail(err));
      secure.once("secureConnect", () => {
        if (settled) return;
        settled = true;
        callback?.(null, secure as unknown as Duplex);
      });
    };
    socket.on("data", onData);
    // The socket is handed over through the callback once the tunnel is up, so
    // there is nothing to return synchronously.
    return null;
  }
}
