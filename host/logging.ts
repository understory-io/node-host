import { performance } from 'perf_hooks'
import { AbortSignal, Json, Logger } from '../context.js'
import { LogEntry, LogLevel, LogTransport, RootLogger } from './context.js'

export function makeLogger(
    transport: LogTransport,
    minimumLogLevel: LogLevel | undefined,
    signal: AbortSignal,
): RootLogger {
    return new EnrichingLogger(
        new LogBuffer(transport, signal),
        minimumLogLevel
            ? ['fatal', 'error', 'warning', 'info', 'debug', 'trace'].indexOf(minimumLogLevel)
            : 5,
        signal,
    )
}

const performanceTimeOrigin100ns = Math.round(performance.timeOrigin * 10000)

export function highPrecisionISODate(performanceNow: number) {
    const now100ns = performanceTimeOrigin100ns + Math.round(performanceNow * 10000)
    return (
        new Date(now100ns / 10000).toISOString().substring(0, 20) +
        (now100ns % 10000000).toString().padStart(7, '0') +
        'Z'
    )
}

class LogBuffer {
    readonly #transport: LogTransport
    #entries: LogEntry[] = []
    #size = 0
    #flusher?: Promise<void> | undefined
    readonly #signal: AbortSignal
    #asyncTransport: boolean | undefined
    #timeout: NodeJS.Timeout | undefined

    constructor(transport: LogTransport, signal: AbortSignal) {
        this.#transport = transport
        this.#signal = signal
    }

    collect(
        level: LogLevel,
        numericLogLevel: number,
        message: string,
        error: unknown,
        fields: object | undefined,
        reservedEnrichment: object | undefined,
        customEnrichment: object | undefined,
    ) {
        const offset = performance.now()
        const json = JSON.stringify({
            timestamp: highPrecisionISODate(offset),
            level,
            message,
            error: errorAsJson(error),
            ...reservedEnrichment,
            ...((fields || customEnrichment) && {
                fields: customEnrichment
                    ? fields
                        ? { ...customEnrichment, ...fields }
                        : customEnrichment
                    : fields,
            }),
        })
        this.#entries.push({
            timestamp: offset,
            level,
            message,
            error,
            json,
        })
        this.#size += json.length

        if (this.#asyncTransport === false) {
            // eslint-disable-next-line no-void
            void this.#transport.sendEntries(this.#entries, this.#signal)
            this.#entries = []
            this.#size = 0
        } else if (this.#asyncTransport === undefined) {
            this.#asyncTransport = true
            setImmediate(() => {
                if (this.#flusher) {
                    return
                }
                const sendResult = this.#transport.sendEntries(this.#entries, this.#signal)
                this.#entries = []
                this.#size = 0
                if (sendResult) {
                    this.#flusher = sendResult
                } else {
                    this.#asyncTransport = false
                }
            })
        } else {
            if (numericLogLevel < 2 || this.#entries.length > 8 || this.#size > 64000) {
                // eslint-disable-next-line no-void
                void this.flush()
            } else {
                this.#timeout = setTimeout(() => {
                    // eslint-disable-next-line no-void
                    void this.flush()
                    this.#timeout = undefined
                }, 2000)
            }
        }
    }

    async flush(): Promise<void> {
        if (this.#entries.length === 0) {
            return
        }
        this.#startFlush(this.#entries)
        this.#entries = []
        this.#size = 0
        if (this.#timeout) {
            clearTimeout(this.#timeout)
            this.#timeout = undefined
        }
        return await this.#flusher
    }

    #startFlush(entries: LogEntry[]) {
        if (this.#flusher) {
            this.#flusher = this.#flusher.then(() =>
                this.#transport.sendEntries(entries, this.#signal),
            )
        } else {
            this.#flusher = this.#transport.sendEntries(entries, this.#signal)
        }
    }
}

class EnrichingLogger implements Logger {
    readonly #buffer: LogBuffer
    readonly #reservedEnrichment?: object
    readonly #customEnrichment?: object
    readonly #level: number

    constructor(
        buffer: LogBuffer,
        level: number,
        reservedEnrichment?: object,
        customEnrichment?: object,
    ) {
        this.#buffer = buffer
        this.#level = level
        this.#reservedEnrichment = reservedEnrichment
        this.#customEnrichment = customEnrichment
    }

    enrich(fields: object): Logger {
        return new EnrichingLogger(this.#buffer, this.#level, this.#reservedEnrichment, {
            ...(this.#customEnrichment ?? {}),
            ...fields,
        })
    }

    flush() {
        return this.#buffer.flush()
    }

    enrichReserved(fields: object): EnrichingLogger {
        return new EnrichingLogger(
            this.#buffer,
            this.#level,
            {
                ...(this.#reservedEnrichment ?? {}),
                ...fields,
            },
            this.#customEnrichment,
        )
    }

    trace(message: string, error: unknown, fields: object | undefined): void {
        if (this.#level < 5) {
            return
        }
        this.#buffer.collect(
            'trace',
            5,
            message,
            error,
            fields,
            this.#reservedEnrichment,
            this.#customEnrichment,
        )
    }
    debug(message: string, error: unknown, fields: object | undefined): void {
        if (this.#level < 4) {
            return
        }
        this.#buffer.collect(
            'debug',
            4,
            message,
            error,
            fields,
            this.#reservedEnrichment,
            this.#customEnrichment,
        )
    }
    info(message: string, error: unknown, fields: object | undefined): void {
        if (this.#level < 3) {
            return
        }
        this.#buffer.collect(
            'debug',
            3,
            message,
            error,
            fields,
            this.#reservedEnrichment,
            this.#customEnrichment,
        )
    }
    warn(message: string, error: unknown, fields: object | undefined): void {
        if (this.#level < 2) {
            return
        }
        this.#buffer.collect(
            'debug',
            2,
            message,
            error,
            fields,
            this.#reservedEnrichment,
            this.#customEnrichment,
        )
    }
    error(message: string, error: unknown, fields: object | undefined): void {
        if (this.#level < 1) {
            return
        }
        this.#buffer.collect(
            'error',
            1,
            message,
            error,
            fields,
            this.#reservedEnrichment,
            this.#customEnrichment,
        )
    }
    fatal(message: string, error: unknown, fields: object | undefined): void {
        this.#buffer.collect(
            'fatal',
            0,
            message,
            error,
            fields,
            this.#reservedEnrichment,
            this.#customEnrichment,
        )
    }
}

function errorAsJson(error: unknown): Json | undefined {
    if (error === undefined || error === null) {
        return undefined
    }
    if (error instanceof Error) {
        return {
            message: error.message,
            name: error.name,
            stack: error.stack,
            ...(error as unknown as { [key: string]: unknown }),
        } as Json
    }
    if (error instanceof Object) {
        return {
            ...error,
        } as Json
    }
    return {
        message: (error as object | undefined)?.toString(),
        name: typeof error,
    } as Json
}
