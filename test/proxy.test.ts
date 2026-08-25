import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyForUrl, bypassesProxy, ProxyTunnelAgent } from "../src/util/proxy.js";

const VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  try {
    for (const k of VARS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
    return fn();
  } finally {
    for (const k of VARS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("proxyForUrl", () => {
  const target = new URL("https://api.elevenlabs.io/v1/x");

  test("is null when nothing is configured", () => {
    withEnv({}, () => assert.equal(proxyForUrl(target), null));
  });

  test("reads HTTPS_PROXY for an https target", () => {
    withEnv({ HTTPS_PROXY: "http://proxy.corp:8080" }, () => {
      assert.equal(proxyForUrl(target)?.host, "proxy.corp:8080");
    });
  });

  test("accepts the lowercase spelling, which is the common one", () => {
    withEnv({ https_proxy: "http://proxy.corp:8080" }, () => {
      assert.equal(proxyForUrl(target)?.host, "proxy.corp:8080");
    });
  });

  test("accepts a bare host:port, which is not a valid URL on its own", () => {
    withEnv({ HTTPS_PROXY: "proxy.corp:3128" }, () => {
      const p = proxyForUrl(target);
      assert.equal(p?.hostname, "proxy.corp");
      assert.equal(p?.port, "3128");
    });
  });

  test("falls back to HTTP_PROXY when only that is set", () => {
    withEnv({ HTTP_PROXY: "http://proxy.corp:8080" }, () => {
      assert.equal(proxyForUrl(target)?.host, "proxy.corp:8080");
    });
  });

  test("keeps credentials for proxies that demand them", () => {
    withEnv({ HTTPS_PROXY: "http://alice:s3cret@proxy.corp:8080" }, () => {
      const p = proxyForUrl(target)!;
      assert.equal(p.username, "alice");
      assert.equal(p.password, "s3cret");
    });
  });

  test("NO_PROXY wins over a configured proxy", () => {
    withEnv({ HTTPS_PROXY: "http://proxy.corp:8080", NO_PROXY: "elevenlabs.io" }, () => {
      assert.equal(proxyForUrl(target), null);
    });
  });

  test("garbage is ignored rather than thrown", () => {
    withEnv({ HTTPS_PROXY: "://" }, () => assert.equal(proxyForUrl(target), null));
  });
});

describe("bypassesProxy", () => {
  test("matches a host and its subdomains, dotted or not", () => {
    withEnv({ NO_PROXY: "corp.internal" }, () => {
      assert.equal(bypassesProxy("corp.internal"), true);
      assert.equal(bypassesProxy("api.corp.internal"), true);
      assert.equal(bypassesProxy("notcorp.internal"), false, "must not match mid-label");
    });
    withEnv({ NO_PROXY: ".corp.internal" }, () => {
      assert.equal(bypassesProxy("api.corp.internal"), true);
    });
  });

  test("is case-insensitive and tolerates spaces and ports", () => {
    withEnv({ NO_PROXY: " LOCALHOST:8080 , Corp.Internal " }, () => {
      assert.equal(bypassesProxy("localhost"), true);
      assert.equal(bypassesProxy("corp.internal"), true);
    });
  });

  test("* exempts everything", () => {
    withEnv({ NO_PROXY: "*" }, () => assert.equal(bypassesProxy("anything.example"), true));
  });

  test("an unset or empty value exempts nothing", () => {
    withEnv({}, () => assert.equal(bypassesProxy("example.com"), false));
    withEnv({ NO_PROXY: "  " }, () => assert.equal(bypassesProxy("example.com"), false));
  });
});

/* -------------------- The tunnel, against a real proxy -------------------- */

/**
 * A throwaway TLS certificate.
 *
 * Node cannot mint an X.509 certificate on its own, so this shells out. The key
 * never leaves the temp directory and protects a server that only ever listens
 * on loopback for the length of this file.
 */
function selfSigned(): { key: string; cert: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "reel-tls-"));
  try {
    execFileSync(
      "openssl",
      // prettier-ignore
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=127.0.0.1",
        "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"),
      ],
      { stdio: "ignore" },
    );
    return {
      key: readFileSync(join(dir, "k.pem"), "utf8"),
      cert: readFileSync(join(dir, "c.pem"), "utf8"),
    };
  } catch {
    return null; // no openssl — the negotiation tests below still run
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A CONNECT proxy that joins the client to whatever it asked for. */
function connectProxy(onLine: (line: string) => void): Promise<net.Server> {
  const server = net.createServer((client) => {
    client.once("data", (buf) => {
      const line = buf.toString().split("\r\n")[0] ?? "";
      onLine(line);
      const target = /^CONNECT (\S+):(\d+)/.exec(line);
      if (!target) return void client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      const upstream = net.connect(Number(target[2]), "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on("error", () => client.destroy());
      // Both halves of a tunnel have to die together, or the runner finishes
      // with a socket still open and reports a pending promise.
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
  });
  server.unref();
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

/** A proxy that answers every CONNECT with one canned status. */
function refusingProxy(status: string): Promise<net.Server> {
  const server = net.createServer((c) => c.once("data", () => c.end(`HTTP/1.1 ${status}\r\n\r\n`)));
  server.unref();
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

const portOf = (s: net.Server) => (s.address() as net.AddressInfo).port;

function getThrough(agent: https.Agent, host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port, path: "/", method: "GET", agent }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve(out));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("ProxyTunnelAgent", () => {
  const tls = selfSigned();
  let origin: https.Server | null = null;
  let proxy: net.Server | null = null;
  let sawConnect = "";

  before(async () => {
    if (tls) {
      origin = https.createServer({ key: tls.key, cert: tls.cert }, (_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("through the tunnel");
      });
      origin.unref();
      await new Promise<void>((r) => origin!.listen(0, "127.0.0.1", r));
    }
    proxy = await connectProxy((l) => (sawConnect = l));
  });

  after(async () => {
    // `close()` waits for live connections, and a tunnel is a live connection
    // on both servers — without this the suite hangs on teardown even though
    // every test has passed. Present at runtime, absent from these @types.
    type Closable = { closeAllConnections?: () => void };
    (origin as Closable | null)?.closeAllConnections?.();
    (proxy as Closable | null)?.closeAllConnections?.();
    if (origin) await new Promise<void>((r) => origin!.close(() => r()));
    if (proxy) await new Promise<void>((r) => proxy!.close(() => r()));
  });

  test("reaches an origin only reachable through the proxy", { skip: !tls }, async () => {
    // Verification is off because the cert is self-signed. What is under test is
    // the tunnel; the trust store has its own flag and its own reason to exist.
    const agent = new ProxyTunnelAgent(new URL(`http://127.0.0.1:${portOf(proxy!)}`), {
      rejectUnauthorized: false,
      timeoutMs: 10_000,
    });
    const port = portOf(origin!);
    try {
      assert.equal(await getThrough(agent, "127.0.0.1", port), "through the tunnel");
      assert.equal(sawConnect, `CONNECT 127.0.0.1:${port} HTTP/1.1`);
    } finally {
      agent.destroy();
    }
  });

  test("reports a refused tunnel instead of hanging", async () => {
    const server = await refusingProxy("403 Forbidden");
    const agent = new ProxyTunnelAgent(new URL(`http://127.0.0.1:${portOf(server)}`), {
      rejectUnauthorized: false,
      timeoutMs: 5_000,
    });
    await assert.rejects(
      () => getThrough(agent, "example.invalid", 443),
      /refused the tunnel: HTTP\/1\.1 403/,
    );
    agent.destroy();
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("names authentication as the problem when the proxy asks for it", async () => {
    const server = await refusingProxy("407 Proxy Authentication Required");
    const agent = new ProxyTunnelAgent(new URL(`http://127.0.0.1:${portOf(server)}`), {
      rejectUnauthorized: false,
      timeoutMs: 5_000,
    });
    await assert.rejects(
      () => getThrough(agent, "example.invalid", 443),
      /requires authentication \(407\)[\s\S]*user:pass@host:port/,
    );
    agent.destroy();
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
