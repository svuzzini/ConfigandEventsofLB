/** Minimal structured logger — no dependency, JSON lines to stderr. */
type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  const line = { t: new Date().toISOString(), level, msg, ...(extra ?? {}) };
  const text = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(text + '\n');
  else process.stdout.write(text + '\n');
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) =>
    process.env['LOG_DEBUG'] ? emit('debug', msg, extra) : undefined,
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
};
