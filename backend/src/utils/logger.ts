import pino from 'pino';
import config from '../config/config';

const isDevelopment = !config.isProd;

/**
 * Sensitive paths stripped from every log line. An Axios failure carries the whole outbound
 * request on `err.config` — including the Authorization header that authenticated it — and
 * `pino.stdSerializers.err` copies it into the log, so any `logger.error({ err })` on a failed
 * upstream call (GitHub, Keycloak, Redash, ...) prints a live credential. `headers` is censored
 * whole rather than by name because each upstream carries auth differently.
 *
 * Deliberately duplicated from src/utils/logger.ts rather than imported: hermes is vendored from
 * the standalone repo and imports nothing outside src/hermes.
 */
const SENSITIVE_REDACT_PATHS = [
  'err.config.headers',
  'err.config.auth',
  'error.config.headers',
  'error.config.auth',
];

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: { paths: SENSITIVE_REDACT_PATHS },
  ...(isDevelopment && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
        ignore: 'pid,hostname',
        singleLine: false,
        messageFormat: '{levelLabel} - {msg}',
        errorLikeObjectKeys: ['err', 'error'],
      },
    },
  }),
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
  },
  formatters: {
    level: (label, number) => {
      return { level: number, levelLabel: label.toUpperCase() };
    },
  },
});

export default logger;
