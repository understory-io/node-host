import { AbortSignal, Json, Logger } from '../context.js'
import { BufferedEvent, ClientInfo, EventMetadata, EventTransport } from './context.js'

type EmitBuffer = {
    [topic: string]: BufferedEvent[]
}

export class EventEmitter {
    readonly #transport: EventTransport
    readonly #logger: Logger
    readonly #ids: ClientInfo
    #emitted: EmitBuffer = {}
    #size = 0
    #flusher?: Promise<void>
    readonly #deadline: number
    #buffered: number
    readonly #signal: AbortSignal

    constructor(
        transport: EventTransport,
        logger: Logger,
        ids: { operationId?: string; clientId?: string; clientIp?: string; userAgent?: string },
        timeout: number,
        signal: AbortSignal,
    ) {
        this.#transport = transport
        this.#logger = logger
        this.#ids = ids
        this.#deadline = new Date().getTime() + timeout
        this.#buffered = 0
        this.#signal = signal
    }

    emit(meta: EventMetadata, data?: Json): void {
        const eventTime = new Date()
        const timeLeft = this.#deadline - new Date().getTime()
        if (this.#buffered / this.#transport.publishRate > timeLeft) {
            throw new Error('Event overflow.')
        }
        const event =
            data === undefined
                ? { meta, ids: this.#ids, eventTime }
                : { meta, ids: this.#ids, eventTime, json: JSON.stringify(data) }
        const events = this.#emitted[meta.topic]
        if (!events) {
            this.#emitted[meta.topic] = [event]
        } else {
            events.push(event)
            if (events.length > 64 || this.#size > 64000) {
                // eslint-disable-next-line no-void
                void this.flush()
            }
        }
        ++this.#buffered
        this.#size += event.json?.length ?? 0
    }

    async flush(): Promise<void> {
        this.#startFlush(this.#emitted)
        this.#emitted = {}
        this.#size = 0
        return await this.#flusher
    }

    #startFlush(emitted: EmitBuffer) {
        if (this.#flusher) {
            this.#flusher = this.#flusher.then(() => this.#flushEvents(emitted))
        } else {
            this.#flusher = this.#flushEvents(emitted)
        }
    }

    async #flushEvents(emitted: EmitBuffer) {
        await Promise.all(
            Object.entries(emitted).map(async ([topic, events]) => {
                try {
                    await this.#transport.sendEvents(topic, events, this.#signal)
                } catch (e) {
                    this.#logger.fatal('Error sending events.', e, { events })
                }
                this.#buffered -= events.length
            }),
        )
    }
}
