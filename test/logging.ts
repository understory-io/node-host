import assert from 'node:assert/strict'
import type { LogEntry } from '../host/context.js'
import { makeLogger } from '../host/logging.js'
import { REDACTED } from '../host/redaction.js'

type Logged = {
    message: string
    error?: {
        message?: string
        stack?: string
        body?: unknown
        response?: { status?: number; body?: unknown }
    }
    fields?: { [key: string]: unknown }
}

async function capture(write: (log: ReturnType<typeof makeLogger>) => void) {
    const entries: LogEntry[] = []
    const log = makeLogger(
        {
            sendEntries: sent => {
                entries.push(...sent)
                return undefined
            },
        },
        'trace',
        new AbortController().signal,
    )
    write(log)
    await new Promise<void>(resolve => {
        setImmediate(resolve)
    })
    const output = entries.map(e => e.json).join('\n')
    return { output, lines: entries.map(e => JSON.parse(e.json) as Logged) }
}

function assertNotLogged(output: string, ...secrets: string[]) {
    for (const secret of secrets) {
        assert.equal(output.includes(secret), false, `"${secret}" was logged`)
    }
}

describe('logging', () => {
    it('redacts credential fields that code logs itself', async () => {
        const configuration = {
            NODE_ENV: 'control-environment',
            REGION: 'control-region',
            SIGNING_PRIVATE_KEY: 'fake-private-key',
            WEBHOOK_SECRET: 'fake-webhook-secret',
            SESSION_TOKEN: 'fake-session-token',
            SERVICE_API_KEY: 'fake-service-api-key',
        }

        const { output, lines } = await capture(log => {
            log.enrich({ client: { appId: 'control-app', appSecret: 'fake-app-secret' } }).info(
                'Loaded configuration',
                undefined,
                { configuration },
            )
        })

        assertNotLogged(
            output,
            'fake-private-key',
            'fake-webhook-secret',
            'fake-session-token',
            'fake-service-api-key',
            'fake-app-secret',
        )
        assert.deepEqual(lines[0]?.fields, {
            client: { appId: 'control-app', appSecret: REDACTED },
            configuration: {
                NODE_ENV: 'control-environment',
                REGION: 'control-region',
                SIGNING_PRIVATE_KEY: REDACTED,
                WEBHOOK_SECRET: REDACTED,
                SESSION_TOKEN: REDACTED,
                SERVICE_API_KEY: REDACTED,
            },
        })
        assert.equal(configuration.SIGNING_PRIVATE_KEY, 'fake-private-key')
    })

    it('redacts the bodies and fields that a logged error carries', async () => {
        const error = Object.assign(new Error('control-message'), {
            body: 'grant_type=client_credentials&client_secret=fake-client-secret',
            response: {
                status: 400,
                body: '{"error":"control-error","access_token":"fake-access-token"}',
            },
            request: { privateKey: 'fake-private-key', id: 'control-id' },
        })

        const { output, lines } = await capture(log => {
            log.error('Upstream call failed', error)
        })

        assertNotLogged(output, 'fake-client-secret', 'fake-access-token', 'fake-private-key')
        const logged = lines[0]?.error
        assert.ok(logged)
        assert.equal(logged.message, 'control-message')
        assert.ok(logged.stack?.includes('control-message'))
        assert.equal(logged.body, `grant_type=client_credentials&client_secret=${REDACTED}`)
        assert.deepEqual(logged.response, {
            status: 400,
            body: `{"error":"control-error","access_token":"${REDACTED}"}`,
        })
        assert.ok(output.includes('control-id'))
        assert.equal(error.response.body.includes('fake-access-token'), true)
    })

    it('logs values it cannot serialize as the marker and keeps the rest of the entry', async () => {
        const circular: { [key: string]: unknown } = { name: 'control-circular' }
        circular.self = circular
        let deep: unknown = 'control-leaf'
        for (let i = 0; i < 100000; ++i) {
            deep = { deep }
        }

        const { lines } = await capture(log => {
            log.info('Still logged', undefined, {
                circular,
                deep,
                count: BigInt(42),
                readable: 'control-value',
            })
        })

        assert.deepEqual(lines[0], {
            ...lines[0],
            message: 'Still logged',
            fields: {
                circular: REDACTED,
                deep: REDACTED,
                count: '42',
                readable: 'control-value',
            },
        })
    })
})
