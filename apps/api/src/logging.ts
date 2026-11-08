import { pino, type DestinationStream, type LevelWithSilentOrString, type Logger } from 'pino';

/**
 * Log safety. Errors here routinely carry text that must never reach a log line: Drizzle's
 * query errors repeat the SQL parameters (issue titles and bodies), Postgres messages quote the
 * offending value, validation errors quote model output, and SDK and HTTP errors carry response
 * bodies and headers.
 *
 * So errors are logged by allowlist, failing closed: the class, a code, an HTTP status, a
 * request ID, whether it is retryable, and the stack frames. The message is kept only when the
 * code that threw the error vouched for it with {@link LOG_MESSAGE}. Everything else (other
 * properties, headers, bodies, SQL and its parameters) is dropped.
 */

/**
 * Set on an error to give the text that is safe to log in place of its message. Only this
 * app's code can set it: a symbol cannot come from parsed JSON or a third-party error.
 */
export const LOG_MESSAGE = Symbol('logMessage');

/** What a log line keeps of an error. */
export interface SafeError {
  type: string;
  message?: string;
  code?: string | number;
  status?: number;
  requestId?: string;
  retryable?: boolean;
  stack?: string;
  cause?: SafeError;
}

const serialized = new WeakSet<object>();
const MAX_CAUSE_DEPTH = 3;
const MAX_STACK_FRAMES = 20;
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The pino serializer for errors (the `err` key, and any other top-level key holding one). */
export function serializeError(value: unknown): SafeError {
  if (typeof value === 'object' && value !== null && serialized.has(value)) {
    return value as SafeError;
  }
  return mark(toSafeError(value, 0));
}

function mark(safe: SafeError): SafeError {
  serialized.add(safe);
  return safe;
}

function toSafeError(value: unknown, depth: number): SafeError {
  if (!(value instanceof Error)) {
    // A thrown string or object can hold anything: keep only what kind of value it was.
    return { type: value === null ? 'null' : typeof value };
  }
  const safe: SafeError = { type: errorType(value) };
  const fields = value as unknown as Record<PropertyKey, unknown>;

  const message = fields[LOG_MESSAGE];
  if (typeof message === 'string') {
    safe.message = message;
  }
  const code = fields.code;
  if ((typeof code === 'string' && CODE.test(code)) || Number.isInteger(code)) {
    safe.code = code as string | number;
  }
  const status = [fields.status, fields.statusCode].find(isHttpStatus);
  if (status !== undefined) {
    safe.status = status;
  }
  // The Anthropic SDK's `requestID`: what Anthropic support needs to find the request.
  const requestId = fields.requestID;
  if (typeof requestId === 'string' && REQUEST_ID.test(requestId)) {
    safe.requestId = requestId;
  }
  if (typeof fields.retryable === 'boolean') {
    safe.retryable = fields.retryable;
  }
  const stack = stackFrames(value);
  if (stack !== undefined) {
    safe.stack = stack;
  }
  if (value.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    safe.cause = toSafeError(value.cause, depth + 1);
  }
  return safe;
}

function errorType(error: Error): string {
  if (IDENTIFIER.test(error.name)) {
    return error.name;
  }
  const constructorName = (error.constructor as { name?: unknown } | undefined)?.name;
  return typeof constructorName === 'string' && IDENTIFIER.test(constructorName)
    ? constructorName
    : 'Error';
}

function isHttpStatus(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
}

/**
 * The stack's `at` lines, without its first line (which repeats the message). The message is
 * located and cut off first, because a multi-line message can contain lines that look like
 * frames. If the message cannot be found in the stack (it was changed after the error was
 * created), the stack is dropped.
 */
function stackFrames(error: Error): string | undefined {
  const { stack, message } = error;
  if (typeof stack !== 'string') {
    return undefined;
  }
  const end = message === '' ? 0 : stack.indexOf(message);
  if (end === -1) {
    return undefined;
  }
  const frames = stack
    .slice(end + message.length)
    .split('\n')
    .filter((line) => /^\s+at \S/.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => line.trim());
  return frames.length > 0 ? frames.join('\n') : undefined;
}

/** Replaces errors anywhere at the top level of a log object, whatever their key. */
function serializeErrorsIn(object: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(object)) {
    if (value instanceof Error) {
      copy ??= { ...object };
      copy[key] = serializeError(value);
    }
  }
  return copy ?? object;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Without a message argument, pino uses the error's message as the log message. Give it the
 * vouched-for text, or the error's type, instead. Errors passed as format arguments are
 * serialized too.
 */
function logMethod(this: Logger, args: unknown[], method: (...args: unknown[]) => void): void {
  let [first, ...rest] = args;
  if (first instanceof Error) {
    first = { err: first };
  }
  if (isRecord(first) && first.err !== undefined && typeof rest[0] !== 'string') {
    const safe = serializeError(first.err);
    rest = [safe.message ?? safe.type, ...rest];
  }
  rest = rest.map((value) => (value instanceof Error ? serializeError(value) : value));
  method.apply(this, [first, ...rest]);
}

export interface LoggerOptions {
  level?: LevelWithSilentOrString;
  name?: string;
}

/**
 * The app's logger: every process (API, worker, scripts) and every test about logging uses
 * this, so they all get the same error handling. Fastify's request loggers are children of it
 * and inherit it.
 */
export function createLogger(options: LoggerOptions = {}, destination?: DestinationStream): Logger {
  const pinoOptions = {
    ...options,
    serializers: { err: serializeError },
    formatters: { log: serializeErrorsIn },
    hooks: { logMethod: logMethod as never },
    // Defense in depth: nothing should log headers, but if something does, drop them.
    redact: {
      paths: ['headers', '*.headers', 'authorization', '*.authorization'],
      remove: true,
    },
  };
  return destination ? pino(pinoOptions, destination) : pino(pinoOptions);
}
