import assert from 'node:assert/strict'
import { createContext, LogEntry } from '../host/context.js'
import { executeRequest, redactHeaders } from '../host/http.js'
import type { HttpHandler } from '../host/registry.js'

type Logged = {
    message: string
    request: { headers: { [key: string]: string } }
    response?: { headers: { [key: string]: string } }
}

const credentials = {
    'api-key': 'fake-api-key-value',
    authorization: 'Bearer fake-jwt-value',
    cookie: 'session=fake-cookie-value',
    'x-shallow': 'fake-shallow-value',
    'stripe-signature': 'fake-signature-value',
}

function handler(responseHeaders: { [key: string]: string }, seen: unknown[]): HttpHandler {
    return {
        meta: undefined,
        config: undefined,
        method: 'POST',
        pathPattern: '/collect',
        pathRegExp: /^\/collect$/u,
        entry: (_context, request) => {
            seen.push(request.headers)
            return { status: 200, headers: responseHeaders, body: { ok: true } }
        },
    }
}

async function run(requestHeaders: { [key: string]: string }, responseHeaders = {}) {
    const entries: LogEntry[] = []
    const seen: unknown[] = []
    const { log, context, success, flush } = createContext(
        {},
        [
            {
                sendEntries: sent => {
                    entries.push(...sent)
                    return undefined
                },
            },
        ],
        { publishRate: 1, sendEvents: () => Promise.resolve() },
        { default: 15 },
        new AbortController(),
    )
    await executeRequest(
        log,
        context,
        handler(responseHeaders, seen),
        { uri: 'https://tracking.example/collect', headers: requestHeaders, json: {} },
        success,
        false,
    )
    await flush()
    await new Promise<void>(resolve => {
        setImmediate(resolve)
    })
    const output = entries.map(e => e.json).join('\n')
    const end = entries
        .map(e => JSON.parse(e.json) as Logged)
        .find(l => l.message === 'Request END')
    assert.ok(end, 'Request END was not logged')
    return { output, end, seen }
}

describe('request logging', () => {
    it('logs credential headers by name, without their values', async () => {
        const { output, end } = await run({ ...credentials, 'user-agent': 'test-agent' })

        for (const value of Object.values(credentials)) {
            assert.ok(!output.includes(value), `log output contains ${value}`)
        }
        assert.equal(end.request.headers['api-key'], '[REDACTED]')
        assert.equal(end.request.headers['user-agent'], 'test-agent')
    })

    it('redacts credential response headers', async () => {
        const { output, end } = await run({}, { 'set-cookie': 'session=fake-set-cookie-value' })

        assert.ok(!output.includes('fake-set-cookie-value'))
        assert.equal(end.response?.headers['set-cookie'], '[REDACTED]')
    })

    it('passes the real headers to the handler', async () => {
        const { seen } = await run({ 'api-key': 'fake-api-key-value' })

        assert.deepEqual(seen, [{ 'api-key': 'fake-api-key-value' }])
    })

    it('matches header names regardless of case', () => {
        assert.deepEqual(redactHeaders({ 'Api-Key': 'x', Authorization: 'y', Accept: 'z' }), {
            'Api-Key': '[REDACTED]',
            Authorization: '[REDACTED]',
            Accept: 'z',
        })
    })
})
