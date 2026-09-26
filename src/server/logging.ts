import loggerModule from './logger.cjs';
import errors from './logging/errors.json' with { type: 'json' };
import type { Secrets } from './config.js';

export const createRedactor = ({ secrets }: { secrets: Secrets }) => {
  const values = Object.values(secrets.values).filter(Boolean).flatMap(v => [v, encodeURIComponent(v), Buffer.from(v).toString('base64')]).sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const value of values) out = out.split(value).join('[REDACTED]');
    return out.replace(/(authorization|cookie|password|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@')
      .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1?[REDACTED]');
  };
};
export const redactValue = <T>({ value, redact }: { value: T; redact: (text: string) => string }): T => {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => redactValue({ value: item, redact })) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue({ value: item, redact })])) as T;
  return value;
};
export const createLogger = ({ secrets }: { secrets: Secrets }) => {
  const redact = createRedactor({ secrets });
  const base: { generateLog: (args: Record<string, unknown>) => unknown; generateError: (args: Record<string, unknown>) => unknown } = loggerModule.debugAndErrors({ settings: { logging: { sinks: { console: { enabled: true, format: 'json', levels: ['info', 'warn', 'error'] } } } }, errorCodeMap: errors });
  return {
    redact,
    sanitize: <T>(value: T) => redactValue({ value, redact }),
    info: (loggerKey: string, message: string, context: Record<string, unknown> = {}, correlationId?: string) => base.generateLog({ level: 'info', caller: 'service-board', loggerKey, message: redact(message), context: redactValue({ value: context, redact }), correlationId }),
    error: (errorKey: string, reason: string, correlationId?: string) => base.generateError({ caller: 'service-board', errorKey, reason: redact(reason), includeStackTrace: false, correlationId }),
  };
};
export type Logger = ReturnType<typeof createLogger>;
