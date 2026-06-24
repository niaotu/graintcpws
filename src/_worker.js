const UUID = '183e65b1-169a-4131-a1ce-d60d7ffe3c93';
const UUID_BYTES = new Uint8Array(UUID.replace(/-/g, '').match(/../g).map(h => parseInt(h, 16)));

export default {
  async fetch(req, env) {
    if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const [client, ws] = Object.values(new WebSocketPair());
      ws.accept();
      // Cloudflare Workers（compat date >= 2026-03-17）默认把二进制帧以 Blob 形式投递给
      // message 事件（websocket_standard_binary_type 兼容标志）。本协议后续逻辑依赖对收到
      // 的数据做同步的 DataView / slice / byteLength 操作，这些操作只对 ArrayBuffer 成立，
      // Blob 不支持。显式指定 binaryType = 'arraybuffer'，且必须在 accept() 之后、第一帧到达
      // 前完成，这样无论 Worker 的兼容日期是新是旧，行为都与原逻辑保持一致，无需改动下方任何解析代码。
      ws.binaryType = 'arraybuffer';

      const u = new URL(req.url);
      const mode = u.searchParams.get('mode') || 'auto';

      const rawS5Param = u.searchParams.get('s5');
      const rawProxyParam = u.searchParams.get('proxyip');
      const rawHttpParam = u.searchParams.get('http');

      const s5Param = rawS5Param ? decodeURIComponent(rawS5Param) : null;
      const proxyParam = rawProxyParam ? decodeURIComponent(rawProxyParam) : null;
      const httpParam = rawHttpParam ? decodeURIComponent(rawHttpParam) : null;
      const path = s5Param ? s5Param : decodeURIComponent(u.pathname).slice(1);

      const socks5 = path.includes('@') ? (() => {
        const [cred, server] = path.split('@');
        const [user, pass] = cred.split(':');
        const [host, port = 443] = server.split(':');
        return { user, pass, host, port: +port };
      })() : null;
      const PROXY_IP = proxyParam ? String(proxyParam) : null;

      const httpProxy = httpParam ? (() => {
        const atIndex = httpParam.lastIndexOf('@');
        if (atIndex === -1) {
          const [host, port = 8080] = httpParam.split(':');
          return { host, port: +port, user: null, pass: null };
        }
        const cred = httpParam.slice(0, atIndex);
        const server = httpParam.slice(atIndex + 1);
        const [user, pass] = cred.split(':');
        const [host, port = 8080] = server.split(':');
        return { user, pass, host, port: +port };
      })() : null;

      const getOrder = () => {
        if (mode === 'proxy') return ['direct', 'proxy'];
        if (mode !== 'auto') return [mode];
        const order = [];
        const searchStr = u.search.slice(1);
        for (const pair of searchStr.split('&')) {
          const key = pair.split('=')[0];
          if (key === 'direct') order.push('direct');
          else if (key === 's5') order.push('s5');
          else if (key === 'proxyip') order.push('proxy');
          else if (key === 'http') order.push('http');
        }
        return order.length ? order : ['direct'];
      };

      let remote = null, udpWriter = null, isDNS = false;

      const socks5Connect = async (targetHost, targetPort) => {
        const sock = req.fetcher.connect({ hostname: socks5.host, port: socks5.port });
        await sock.opened;
        const w = sock.writable.getWriter();
        const r = sock.readable.getReader();
        await w.write(new Uint8Array([5, 2, 0, 2]));
        const auth = (await r.read()).value;
        if (auth[1] === 2 && socks5.user) {
          const user = new TextEncoder().encode(socks5.user);
          const pass = new TextEncoder().encode(socks5.pass);
          await w.write(new Uint8Array([1, user.length, ...user, pass.length, ...pass]));
          await r.read();
        }
        const domain = new TextEncoder().encode(targetHost);
        await w.write(new Uint8Array([5, 1, 0, 3, domain.length, ...domain, targetPort >> 8, targetPort & 0xff]));
        await r.read();
        w.releaseLock();
        r.releaseLock();
        return sock;
      };

      const httpConnect = async (targetHost, targetPort) => {
        const sock = req.fetcher.connect({ hostname: httpProxy.host, port: httpProxy.port });
        await sock.opened;
        const w = sock.writable.getWriter();
        let reqStr = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`;
        if (httpProxy.user) reqStr += `Proxy-Authorization: Basic ${btoa(`${httpProxy.user}:${httpProxy.pass}`)}\r\n`;
        reqStr += `\r\n`;
        await w.write(new TextEncoder().encode(reqStr));
        w.releaseLock();
        const r = sock.readable.getReader();
        let resp = '';
        while (true) {
          const { value, done } = await r.read();
          if (done) throw new Error();
          resp += new TextDecoder().decode(value);
          if (resp.includes('\r\n\r\n')) break;
        }
        r.releaseLock();
        return sock;
      };

      new ReadableStream({
        start(ctrl) {
          ws.addEventListener('message', e => ctrl.enqueue(e.data));
          ws.addEventListener('close', () => {
            remote?.close();
            ctrl.close();
          });
          ws.addEventListener('error', () => {
            remote?.close();
            ctrl.error();
          });

          const early = req.headers.get('sec-websocket-protocol');
          if (early) {
            try {
              ctrl.enqueue(
                Uint8Array.from(
                  atob(early.replace(/-/g, '+').replace(/_/g, '/')),
                  c => c.charCodeAt(0)
                ).buffer
              );
            } catch {}
          }
        }
      }).pipeTo(new WritableStream({
        async write(data) {
          if (isDNS) return udpWriter?.write(data);
          if (remote) {
            const w = remote.writable.getWriter();
            await w.write(data);
            w.releaseLock();
            return;
          }

          if (data.byteLength < 24) return;

          const uuidBytes = new Uint8Array(data.slice(1, 17));
          for (let i = 0; i < 16; i++) {
            if (uuidBytes[i] !== UUID_BYTES[i]) return;
          }

          const view = new DataView(data);
          const optLen = view.getUint8(17);
          const cmd = view.getUint8(18 + optLen);
          if (cmd !== 1 && cmd !== 2) return;

          let pos = 19 + optLen;
          const port = view.getUint16(pos);
          const type = view.getUint8(pos + 2);
          pos += 3;

          let addr = '';
          if (type === 1) {
            addr = `${view.getUint8(pos)}.${view.getUint8(pos + 1)}.${view.getUint8(pos + 2)}.${view.getUint8(pos + 3)}`;
            pos += 4;
          } else if (type === 2) {
            const len = view.getUint8(pos++);
            addr = new TextDecoder().decode(data.slice(pos, pos + len));
            pos += len;
          } else if (type === 3) {
            const ipv6 = [];
            for (let i = 0; i < 8; i++, pos += 2) ipv6.push(view.getUint16(pos).toString(16).padStart(4, '0'));
            addr = ipv6.join(':');
          } else return;

          const header = new Uint8Array([data[0], 0]);
          const payload = data.slice(pos);

          if (cmd === 2) {
            if (port !== 53) return;
            isDNS = true;
            let sent = false;
            const { readable, writable } = new TransformStream({
              transform(chunk, ctrl) {
                for (let i = 0; i < chunk.byteLength;) {
                  const len = new DataView(chunk.slice(i, i + 2)).getUint16(0);
                  ctrl.enqueue(chunk.slice(i + 2, i + 2 + len));
                  i += 2 + len;
                }
              }
            });

            readable.pipeTo(new WritableStream({
              async write(query) {
                try {
                  const resp = await req.fetcher.fetch('https://1.1.1.1/dns-query', {
                    method: 'POST',
                    headers: { 'content-type': 'application/dns-message' },
                    body: query
                  });
                  if (ws.readyState === 1) {
                    const result = new Uint8Array(await resp.arrayBuffer());
                    ws.send(new Uint8Array([...(sent ? [] : header), result.length >> 8, result.length & 0xff, ...result]));
                    sent = true;
                  }
                } catch {}
              }
            }));
            udpWriter = writable.getWriter();
            return udpWriter.write(payload);
          }

          let sock = null;
          for (const method of getOrder()) {
            try {
              if (method === 'direct') {
                sock = req.fetcher.connect({ hostname: addr, port });
                await sock.opened;
                break;
              } else if (method === 's5' && socks5) {
                sock = await socks5Connect(addr, port);
                break;
              } else if (method === 'http' && httpProxy) {
                sock = await httpConnect(addr, port);
                break;
              } else if (method === 'proxy' && PROXY_IP) {
                const [ph, pp = port] = PROXY_IP.split(':');
                sock = req.fetcher.connect({ hostname: ph, port: +pp || port });
                await sock.opened;
                break;
              }
            } catch {}
          }

          if (!sock) return;

          remote = sock;
          const w = sock.writable.getWriter();
          await w.write(payload);
          w.releaseLock();

          let sent = false;
          sock.readable.pipeTo(new WritableStream({
            write(chunk) {
              if (ws.readyState === 1) {
                ws.send(sent ? chunk : new Uint8Array([...header, ...new Uint8Array(chunk)]));
                sent = true;
              }
            },
            close: () => ws.readyState === 1 && ws.close(),
            abort: () => ws.readyState === 1 && ws.close()
          })).catch(() => {});
        }
      })).catch(() => {});

      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(req.url);
    url.hostname = 'example.com';
    return fetch(new Request(url, req));
  }
};
