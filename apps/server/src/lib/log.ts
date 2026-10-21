type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;
const silent = process.env.NODE_ENV === "test" && !process.env.LOG_LEVEL;

/** The last warnings and errors, newest last, for the admin view. */
const RECENT = 100;
const recent: { id: number; t: string; level: Level; msg: string; fields?: Record<string, unknown> }[] = [];
let seq = 0;

export function recentProblems(): readonly {
  id: number;
  t: string;
  level: Level;
  msg: string;
  fields?: Record<string, unknown>;
}[] {
  return recent;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (level === "warn" || level === "error") {
    recent.push({ id: ++seq, t: new Date().toISOString(), level, msg, fields });
    if (recent.length > RECENT) recent.shift();
  }
  if (silent || ORDER[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** One JSON object per line, so platform log search works without a parser. */
export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
