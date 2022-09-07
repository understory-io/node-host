import { AbortSignal, Context, Environment, Json, Logger } from '../context.js'
import { EventEmitter } from './emitter.js'
import { makeLogger } from './logging.js'
import { Metadata } from './registry.js'

export interface ClientInfo {
    readonly operationId?: string
    readonly clientId?: string
    readonly clientIp?: string
    readonly clientPort?: number
    readonly userAgent?: string
}

export interface EventMetadata {
    topic: string
    type: string
    subject: string
    id?: string
}

export interface BufferedEvent {
    eventTime: Date
    meta: Omit<EventMetadata, 'topic'>
    ids: ClientInfo
    json?: string
}

export interface EventTransport {
    readonly publishRate: number
    sendEvents(topic: string, events: BufferedEvent[], signal: AbortSignal): Promise<void>
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error' | 'fatal'

export interface LogEntry {
    readonly level: LogLevel
    readonly timestamp: number
    readonly message: string
    readonly error: unknown
    readonly json: string
}

export interface LogTransport {
    readonly publishRate?: number
    sendEntries(entries: LogEntry[], signal: AbortSignal): Promise<void> | undefined
}

class LogMulticaster implements LogTransport {
    #transports: LogTransport[]
    readonly publishRate: number

    constructor(transports: LogTransport[]) {
        this.#transports = transports
        this.publishRate = transports.map(t => t.publishRate).sort()[0] ?? Number.MAX_SAFE_INTEGER
    }

    sendEntries(entries: LogEntry[], signal: AbortSignal) {
        const promises = this.#transports.map(t => t.sendEntries(entries, signal)).filter(p => !!p)
        if (promises.length === 0) {
            return
        }
        return Promise.all(promises) as unknown as Promise<void>
    }
}

export interface RootLogger extends Logger {
    enrichReserved(fields: object): RootLogger
    flush(): Promise<void>
}

export function createContext(
    clientInfo: ClientInfo,
    loggers: LogTransport[],
    eventTransport: EventTransport,
    timeouts: { default: number; cap?: number },
    outerController: AbortController,
    meta?: Metadata,
    environment?: Environment | undefined,
    now?: (() => Date) | undefined,
): {
    log: RootLogger
    context: Context
    success: () => Promise<unknown>
    flush: () => Promise<void>
} {
    const timeout =
        (timeouts.cap
            ? Math.min(meta?.config?.timeout ?? timeouts.default, timeouts.cap)
            : meta?.config?.timeout ?? timeouts.default) * 1000
    const innerController = new AbortController()
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const logTransport = loggers.length === 1 ? loggers[0]! : new LogMulticaster(loggers)
    const logger = makeLogger(
        logTransport,
        meta?.config?.minimumLogLevel,
        outerController.signal as AbortSignal,
    )
    logger.enrichReserved({
        operationId: clientInfo.operationId,
        client: {
            id: clientInfo.clientId,
            ip: clientInfo.clientIp,
            port: clientInfo.clientPort,
            userAgent: clientInfo.userAgent,
        },
    })
    globalLogger = logger
    const emitter = new EventEmitter(
        eventTransport,
        logger,
        clientInfo,
        timeout,
        outerController.signal as AbortSignal,
    )
    const successHandlers: (() => Promise<void> | void)[] = []
    const ctx = {
        env: environment ?? (process.env as Environment),
        log: logger,
        signal: innerController.signal as AbortSignal,
        now: now ?? (() => new Date()),
        operationId: clientInfo.operationId,
        client: {
            id: clientInfo.clientId,
            ip: clientInfo.clientIp,
            port: clientInfo.clientPort,
            userAgent: clientInfo.userAgent,
        },
        meta: meta
            ? {
                  packageName: meta.packageName,
                  fileName: meta.fileName,
                  revision: meta.revision,
              }
            : undefined,
        emit: (topic: string, type: string, subject: string, data?: Json, messageId?: string) =>
            emitter.emit({ topic, type, subject, id: messageId }, data),
        eventBarrier: () => emitter.flush(),
        onSuccess: (fn: () => Promise<void> | void) => successHandlers.push(fn),
    }
    const timeoutHandle = setTimeout(() => {
        ctx.log.error('Timeout.', undefined, undefined)
        innerController.abort()
        // eslint-disable-next-line no-void
        void logger.flush()
        // eslint-disable-next-line no-void
        void emitter.flush()
    }, timeout)
    const flushHandle = setTimeout(() => {
        ctx.log.error('Aborting flush.', undefined, undefined)
        outerController.abort()
    }, timeout + 15000)
    return {
        log: logger,
        context: ctx,
        success: () => Promise.all(successHandlers.map(fn => fn())),
        flush: async () => {
            clearTimeout(timeoutHandle)
            await emitter.flush()
            await logger.flush()
            clearTimeout(flushHandle)
        },
    }
}

let globalLogger: Logger | undefined

process.on('uncaughtException', err => {
    globalLogger?.fatal('Uncaught exception.', err, undefined)
})
process.on('unhandledRejection', reason => {
    globalLogger?.fatal('Unhandled rejection.', reason, undefined)
})
