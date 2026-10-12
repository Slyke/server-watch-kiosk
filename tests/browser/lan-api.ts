import type { BrowserContext } from '@playwright/test';
import http from 'node:http';

// Use the real API middleware with a LAN Host, without depending on external DNS.
export const lanApi = async (context: BrowserContext) => {
  await context.route('**/api/v1/**', async route => {
    const request = route.request();
    const headers: Record<string, string> = { ...request.headers(), host: 'board.lan', 'accept-encoding': 'identity' };
    if (headers.origin === new URL(request.url()).origin) headers.origin = 'http://board.lan';
    const result = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolve, reject) => {
      const req = http.request(request.url(), { method: request.method(), headers }, res => {
        const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: Object.fromEntries(Object.entries(res.headers)
          .filter(([name, value]) => typeof value === 'string' && !['content-length', 'transfer-encoding', 'content-encoding'].includes(name))) as Record<string, string>, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('error', reject); req.end(request.postDataBuffer());
    });
    await route.fulfill(result);
  });
};

