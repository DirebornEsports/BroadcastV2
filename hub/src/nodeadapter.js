'use strict';
// Runs the server's Node-style (req, res) handler for a Web Request and returns a Web Response.
// Supports what the server uses: writeHead / write / end, Server-Sent Events (write without end),
// req.on('close') when an event stream is closed, and res.respond(Response) to hand back a fetched response.

async function runNodeHandler(handler, request, extra = {}) {
  const url = new URL(request.url);
  const body = ['GET', 'HEAD'].includes(request.method) ? Buffer.alloc(0) : Buffer.from(await request.arrayBuffer());
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  const closeHandlers = [];
  const req = {
    method: request.method, url: url.pathname + url.search, headers, body, ...extra,
    on(ev, fn) { if (ev === 'close') closeHandlers.push(fn); return req; },
    destroy() {},
  };

  return new Promise((resolve) => {
    let status = 200, outHeaders = {}, chunks = [], done = false, stream = null, writer = null;
    const enc = new TextEncoder();
    const toBytes = (c) => (typeof c === 'string' ? enc.encode(c) : c instanceof Uint8Array ? c : enc.encode(String(c)));
    const finish = (resp) => { if (!done) { done = true; resolve(resp); } };
    const cleanHeaders = () => { const h = new Headers(); for (const [k, v] of Object.entries(outHeaders)) if (v !== undefined && k.toLowerCase() !== 'content-length' && k.toLowerCase() !== 'connection') h.set(k, String(v)); return h; };
    const res = {
      headersSent: false,
      writeHead(code, h) { status = code; outHeaders = { ...outHeaders, ...(h || {}) }; res.headersSent = true; return res; },
      setHeader(k, v) { outHeaders[k] = v; },
      write(chunk) {
        if (!res.headersSent) res.writeHead(200, {});
        if (!stream) {
          // first write before end(): this is a stream (Server-Sent Events)
          const ts = new TransformStream();
          stream = ts; writer = ts.writable.getWriter();
          writer.closed.catch(() => {});
          const reader = ts.readable;
          finish(new Response(new ReadableStream({
            async start(ctrl) {
              const r = reader.getReader();
              try { for (;;) { const { value, done: d } = await r.read(); if (d) break; ctrl.enqueue(value); } ctrl.close(); }
              catch (e) { try { ctrl.error(e); } catch {} }
            },
            cancel() { res._closed = true; try { writer.abort(); } catch {} for (const fn of closeHandlers) { try { fn(); } catch {} } },
          }), { status, headers: cleanHeaders() }));
        }
        if (res._closed) return false;
        writer.write(toBytes(chunk)).catch(() => { if (!res._closed) { res._closed = true; for (const fn of closeHandlers) { try { fn(); } catch {} } } });
        return true;
      },
      end(chunk) {
        if (stream) { if (chunk) res.write(chunk); try { writer.close(); } catch {} return; }
        if (chunk !== undefined && chunk !== null) chunks.push(toBytes(chunk));
        if (!res.headersSent) res.writeHead(status, {});
        const len = chunks.reduce((a, c) => a + c.length, 0), all = new Uint8Array(len);
        let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
        finish(new Response(request.method === 'HEAD' || status === 204 ? null : all, { status, headers: cleanHeaders() }));
      },
      respond(response) { res.headersSent = true; finish(response); },
    };
    Promise.resolve()
      .then(() => handler(req, res))
      .then(() => { if (!done && !stream) setTimeout(() => finish(new Response('No response', { status: 500 })), 30000); })
      .catch((e) => { console.error(e); finish(new Response('Server error', { status: 500 })); });
  });
}

module.exports = { runNodeHandler };
