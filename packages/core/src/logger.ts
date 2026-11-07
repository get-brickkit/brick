import { ATTR, GLOBAL_SYMBOL, SPAN } from "./telemetry-names";
import { formatWithOptions } from "node:util";
import { trace, type Span } from "@opentelemetry/api";
import type { Logger } from "./types";

type Level = keyof Logger;

/**
 * Set by the CLI when a dashboard is collecting logs, in `brick dev` or in
 * `brick start` with the `dashboard` option. A shared symbol, not an option or
 * an export: the CLI and the app may each hold their own copy of this package,
 * and nothing but a dashboard turns it on.
 */
const CAPTURE = Symbol.for(GLOBAL_SYMBOL.logsCapture);
const MAX_MESSAGE_LENGTH = 4000;
/**
 * Logs one span keeps. OpenTelemetry keeps 128 events per span by default,
 * exceptions among them, so a chatty action must not use them all up and
 * lose the stack trace of the error that ends it.
 */
const MAX_LOGS_PER_SPAN = 100;

const logged = new WeakMap<Span, number>();

/**
 * Terminal formatting: colors and styles (`ESC [ … m`, and other CSI codes) and
 * titles or links (`ESC ] … BEL`). Libraries such as Better Auth color their
 * console output, which in a web page shows as stray characters.
 */
// oxlint-disable no-control-regex
const ANSI =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;
// oxlint-enable no-control-regex

export function stripAnsi(text: string): string {
  return text.includes("\u001b") ? text.replace(ANSI, "") : text;
}

/**
 * What `console.log` would print, without terminal colors, with objects cut off
 * at a sensible size.
 */
function render(args: unknown[]): string {
  const text = stripAnsi(
    formatWithOptions(
      { depth: 3, breakLength: 120, maxArrayLength: 50, maxStringLength: 1000 },
      ...args,
    ),
  );
  return text.length > MAX_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…`
    : text;
}

function record(span: Span, level: Level, args: unknown[]): void {
  const count = (logged.get(span) ?? 0) + 1;
  logged.set(span, count);
  if (count > MAX_LOGS_PER_SPAN) {
    // Counted, so the dashboard can say how many it left out.
    span.setAttribute(ATTR.logsDropped, count - MAX_LOGS_PER_SPAN);
    return;
  }
  span.addEvent(SPAN.logEvent, {
    [ATTR.logLevel]: level,
    [ATTR.logMessage]: render(args),
  });
}

/**
 * Record a line on the running span, if a recording one is running. Returns
 * whether it did, so the caller prints only when it did not.
 */
function recordActive(level: Level, args: unknown[]): boolean {
  const span = trace.getActiveSpan();
  if (!span?.isRecording()) return false;
  record(span, level, args);
  return true;
}

// The dev server's console capture calls this by name, for the same reason
// `CAPTURE` is a shared symbol: it may hold a different copy of this package.
(globalThis as Record<symbol, unknown>)[Symbol.for(GLOBAL_SYMBOL.logsRecord)] =
  recordActive;

/**
 * A logger for actions, tools, and endpoints. While a dashboard is on, a line
 * logged while a request is being traced becomes an event on the span that is
 * running, which the dashboard shows with that request (and in its Logs tab);
 * it is not printed. Everywhere else, and for lines logged outside a request,
 * it prints to the console, prefixed by `prefix`: one for all levels, or one
 * per level.
 *
 * Capturing costs one context lookup and a span event per line, and nothing
 * is serialized for the dashboard until the span ends, so it is cheaper than
 * a console write. Lines are cut at 4,000 characters and a span keeps 100.
 */
export function createLogger(prefix: string | Record<Level, string>): Logger {
  const level =
    (name: Level, print: (...args: unknown[]) => void) =>
    (...args: unknown[]): void => {
      if (
        (globalThis as Record<symbol, unknown>)[CAPTURE] === true &&
        recordActive(name, args)
      )
        return;
      print(typeof prefix === "string" ? prefix : prefix[name], ...args);
    };
  return {
    info: level("info", (...args) => console.log(...args)),
    warn: level("warn", (...args) => console.warn(...args)),
    error: level("error", (...args) => console.error(...args)),
    debug: level("debug", (...args) => console.debug(...args)),
  };
}

/** The prefixes of loggers a caller did not supply. */
export const DEFAULT_LOG_PREFIXES: Record<Level, string> = {
  info: "[INFO]",
  warn: "[WARN]",
  error: "[ERROR]",
  debug: "[DEBUG]",
};
