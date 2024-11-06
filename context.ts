import { performance } from "perf_hooks";
import { highPrecisionISODate } from "./host/logging.js";

export type Environment = {
  readonly [key: string]: string;
};

export type Logger = {
  enrich(fields: object): Logger;
  trace(message: string, error?: unknown, fields?: object): void;
  debug(message: string, error?: unknown, fields?: object): void;
  info(message: string, error?: unknown, fields?: object): void;
  warn(message: string, error?: unknown, fields?: object): void;
  error(message: string, error?: unknown, fields?: object): void;
  fatal(message: string, error?: unknown, fields?: object): void;
};

export type AbortSignal = {
  aborted: boolean;

  addEventListener: (
    type: "abort",
    listener: (this: AbortSignal, event: unknown) => unknown,
    options?: { capture?: boolean; once?: boolean; passive?: boolean }
  ) => void;

  removeEventListener: (
    type: "abort",
    listener: (this: AbortSignal, event: unknown) => unknown,
    options?: { capture?: boolean }
  ) => void;
};

export type MutableJson =
  | null
  | boolean
  | number
  | string
  | MutableJson[]
  | { [key: string]: MutableJson };
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/*@__INLINE__*/
export function objectSpreadable(json?: Json): {
  readonly [key: string]: Json;
} {
  if (!json) {
    return {};
  }
  return json as unknown as { readonly [key: string]: Json };
}

/*@__INLINE__*/
export function arraySpreadable(json?: Json): readonly Json[] {
  if (!Array.isArray(json)) {
    return [];
  }
  return json as readonly Json[];
}

export type HandlerConfiguration = {
  /**
   * An indication of CPU usage of the handler.
   * @default 'low'
   */
  readonly compute?: "high" | "low";
  /**
   * An indication of memory usage of the handler.
   * @default 'low'
   */
  readonly memory?: "high" | "low";
  /**
   * A boolean indicating whether to enrich the log with the body of events, requests or responses. Set to false if the body is large or contain very sensitive data.
   * @default false
   */
  readonly excludeBodyFromLogs?: boolean;
  /**
   * The level below which log entries will be discarded.
   * @default 'trace'
   */
  readonly minimumLogLevel?:
    | "trace"
    | "debug"
    | "info"
    | "warning"
    | "error"
    | "fatal";
  /**
   * The number of seconds the function is expected to finish executing in.
   */
  readonly timeout?: number;
  /**
   * Any AWS Lambda Layers to be added to the function. An array of ARNs.
   */
  readonly layers?: string[];
};

export type Context = {
  readonly env: Environment;
  readonly log: Logger;
  readonly signal: AbortSignal;
  now(): Date;

  readonly operationId?: string;
  readonly client?: {
    readonly id?: string;
    readonly ip?: string;
    readonly port?: number;
    readonly userAgent?: string;
  };
  readonly meta?: {
    readonly packageName: string;
    readonly fileName: string;
    readonly revision?: string;
  };

  emit(
    topic: string,
    type: string,
    subject: string,
    data?: Json,
    messageId?: string
  ): void;
  eventBarrier(): Promise<void>;

  onSuccess(fn: () => Promise<void> | void): void;
};

export function httpRequestHeaders(context: Context) {
  const headers: { [key: string]: string } = {
    "user-agent": `${context.meta?.packageName ?? "?"}/${
      context.meta?.revision ?? "?"
    }`,
  };
  if (context.operationId) {
    headers["x-request-id"] = context.operationId;
  }
  if (context.client) {
    if (context.client.id) {
      headers["x-client-id"] = context.client.id;
    }
    if (context.client.ip || context.client.port) {
      headers["x-forwarded-for"] = `${context.client.ip ?? ""}:${
        context.client.port ?? ""
      }`;
    }
    if (context.client.userAgent) {
      headers["x-forwarded-for-user-agent"] = context.client.userAgent;
    }
  }
  return headers;
}

export async function throwOnNotOK<
    T extends { ok?: boolean; status?: number; text?: () => Promise<string> },
>(response: T, message: string, data?: { [key: string]: unknown }) {
    if (response.ok === false) {
        throw Object.assign(new Error(message), {
            response: {
                status: response.status,
                body: limitSize(await response.text?.()),
            },
            ...data,
        })
    }
    return response
}

function limitSize(text: string | undefined) {
    if ((text?.length ?? 0) > 2048) {
        return text?.substring(0, 2048)
    }
    return text
}


export async function measure<T>(
  logger: { trace: (message: string, _: undefined, f: object) => void },
  name: string,
  fn: () => Promise<T> | T,
  fields?: object
) {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    const end = performance.now();
    logger.trace(`Measurement of ${name} time`, undefined, {
      start: highPrecisionISODate(start),
      end: highPrecisionISODate(end),
      duration: (Math.round(end * 10000) - Math.round(start * 10000)) / 10000,
      ...fields,
    });
  }
}
