import pino from 'pino';
import config from '../config/config';

const isDevelopment = !config.isProd;

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
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
