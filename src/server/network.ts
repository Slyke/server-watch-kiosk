import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import type { Source } from './config.js';
import { MAX_BYTES } from './limits.js';

export class UpstreamError extends Error {
  constructor(readonly category: 'forbidden' | 'timeout' | 'transport' | 'limit' | 'invalid' | 'missing', readonly status?: number) { super(category); }
}
export type HttpReply = { status: number; text: string; headers: http.IncomingHttpHeaders; durationMs: number; truncated: boolean };
export const readHttp = async ({ url, method = 'GET', headers = {}, body, signal, tls, options = {}, maxBytes = MAX_BYTES, truncate = false }: {
  url: string; method?: string; headers?: Record<string, string>; body?: string; signal: AbortSignal;
  tls?: Extract<Source, { type: 'http' }>['tls']; options?: https.RequestOptions; maxBytes?: number; truncate?: boolean;
}): Promise<HttpReply> => {
  signal.throwIfAborted();
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new UpstreamError('invalid');
  const started = performance.now();
  return await new Promise<HttpReply>((resolve, reject) => {
    let finished = false;
    const fail = (error: Error) => { if (finished) return; finished = true; return reject(error); };
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      ...options, method, signal,
      headers: { ...options.headers, ...headers, 'accept-encoding': 'identity' },
      ...(tls ? { rejectUnauthorized: tls.rejectUnauthorized, ca: tls.caFile ? fs.readFileSync(tls.caFile) : undefined, cert: tls.certFile ? fs.readFileSync(tls.certFile) : undefined, key: tls.keyFile ? fs.readFileSync(tls.keyFile) : undefined } : {}),
    }, response => {
      const chunks: Buffer[] = []; let size = 0;
      const finish = (truncated: boolean) => {
        if (finished) return; finished = true;
        return resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers, durationMs: performance.now() - started, truncated });
      };
      if (Number(response.headers['content-length']) > maxBytes && !truncate) { fail(new UpstreamError('limit')); response.destroy(); request.destroy(); return; }
      response.on('data', (chunk: Buffer) => {
        if (size + chunk.length > maxBytes) {
          if (truncate) { chunks.push(chunk.subarray(0, Math.max(0, maxBytes - size))); finish(true); } else fail(new UpstreamError('limit'));
          response.destroy(); request.destroy(); return;
        }
        size += chunk.length; chunks.push(chunk);
      });
      response.on('end', () => finish(false));
      response.on('error', () => fail(new UpstreamError(signal.aborted ? 'timeout' : 'transport')));
    });
    request.on('error', () => fail(new UpstreamError(signal.aborted ? 'timeout' : 'transport')));
    if (body) request.write(body);
    request.end();
  });
};
export const jsonBody = ({ reply }: { reply: HttpReply }): unknown => {
  try { return JSON.parse(reply.text); } catch { throw new UpstreamError('invalid'); }
};
