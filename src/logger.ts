export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
const RESERVED_FIELD_KEYS = new Set(["ts", "level", "service", "message"]);

function normalizeLogLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function cleanFields(fields?: LogFields): LogFields {
  if (!fields) {
    return {};
  }
  const output: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      const normalizedKey = RESERVED_FIELD_KEYS.has(key) ? `field_${key}` : key;
      output[normalizedKey] = value;
    }
  }
  return output;
}

export function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null
    };
  }
  return {
    message: String(error)
  };
}

export function createLogger(options?: {
  service?: string;
  minLevel?: string;
  bindings?: LogFields;
}): Logger {
  const service = options?.service ?? "app";
  const minLevel = normalizeLogLevel(options?.minLevel);
  const baseBindings = cleanFields(options?.bindings);

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[minLevel];
  }

  function write(level: LogLevel, message: string, fields?: LogFields): void {
    if (!shouldLog(level)) {
      return;
    }
    const payload = {
      ts: new Date().toISOString(),
      level,
      service,
      message,
      ...baseBindings,
      ...cleanFields(fields)
    };
    const line = JSON.stringify(payload);
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }

  return {
    debug(message: string, fields?: LogFields): void {
      write("debug", message, fields);
    },
    info(message: string, fields?: LogFields): void {
      write("info", message, fields);
    },
    warn(message: string, fields?: LogFields): void {
      write("warn", message, fields);
    },
    error(message: string, fields?: LogFields): void {
      write("error", message, fields);
    },
    child(bindings: LogFields): Logger {
      return createLogger({
        service,
        minLevel,
        bindings: {
          ...baseBindings,
          ...cleanFields(bindings)
        }
      });
    }
  };
}
