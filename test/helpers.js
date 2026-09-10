'use strict';

const http = require('http');

/** 启动一个假上游，记录收到的请求，handler 决定如何响应。 */
function startUpstream(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let json = null;
      try {
        json = JSON.parse(body.toString('utf8'));
      } catch {
        json = null;
      }
      const record = { method: req.method, url: req.url, headers: req.headers, body, json };
      requests.push(record);
      try {
        handler(req, res, record);
      } catch {
        res.destroy();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        requests,
        port,
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(done);
          }),
      });
    });
  });
}

/** 构造一个 SSE 帧（event: 行 + data 行）。 */
function sseFrame(type, payload, { eol = '\n', withEventLine = true } = {}) {
  const obj = { type, ...payload };
  const eventLine = withEventLine ? `event: ${type}${eol}` : '';
  return `${eventLine}data: ${JSON.stringify(obj)}${eol}${eol}`;
}

/** 按给定切片逐块写入 SSE 响应，可选块间延迟（模拟真实的网络分片）。 */
async function writeSse(res, parts, { headers = {}, delayMs = 0 } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    ...headers,
  });
  for (const part of parts) {
    res.write(part);
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  res.end();
}

/** 发一个请求到 relay 并读完整个响应。 */
function request(port, { method = 'POST', path = '/responses', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          raw: Buffer.concat(chunks),
        }),
      );
      // 流被中断时 end 不会触发，必须显式拒绝，否则调用方会一直等待。
      res.on('aborted', () => reject(new Error('response aborted')));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body !== null) {
      req.write(Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

const COLLAB_FUNCTION_CALL = {
  type: 'function_call',
  id: 'fc_1',
  name: 'spawn_agent',
  namespace: 'collaboration',
  arguments: '{"task_name":"probe","message":"ZXQ-TRACER payload: reply with exactly ECHO-ZXQ-TRACER"}',
  call_id: 'call_1',
};

module.exports = { startUpstream, sseFrame, writeSse, request, COLLAB_FUNCTION_CALL };
