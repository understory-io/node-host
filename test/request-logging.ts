// OAuth requests and responses are snake_case on the wire.
/* eslint-disable camelcase */
import assert from 'node:assert/strict'
import type { HandlerConfiguration, Json } from '../context.js'
import { createContext, LogEntry } from '../host/context.js'
import { executeRequest } from '../host/http.js'
import { REDACTED } from '../host/redaction.js'
import { getHandlers, HttpHandler, setMeta } from '../host/registry.js'
import { Handler, HttpRequest, post } from '../http.js'

type Logged = {
    message: string
    error?: {
        message?: string
        body?: unknown
        response?: { status?: number; body?: unknown }
    }
    request: {
        uri: string
        headers: { [key: string]: string }
        json?: { [key: string]: unknown }
        body?: string
    }
    response?: {
        status: number
        headers: { [key: string]: string }
        body?: unknown
    }
}

type RequestOptions = Parameters<typeof executeRequest>[3]

const secrets = [
    'Bearer fake-jwt',
    'fake-basic',
    'fake-api-key',
    'fake-x-api-key',
    'fake-cookie',
    'fake-set-cookie',
    'fake-shallow-key',
    'fake-password-123',
    'fake-refresh-token',
    'fake-access-token',
    'fake-client-secret',
    'fake-token',
    'fake-access-key',
    'fake-key',
    'fake-signature',
    'fake-api-secret',
    'fake-new-password',
]

async function run(handler: HttpHandler, options: RequestOptions) {
    const entries: LogEntry[] = []
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
        handler.meta,
        {},
    )
    const response = await executeRequest(log, context, handler, options, success, false)
    await flush()
    await new Promise<void>(resolve => {
        setImmediate(resolve)
    })
    const output = entries.map(e => e.json).join('\n')
    const lines = entries.map(e => JSON.parse(e.json) as Logged)
    const end = lines.find(l => l.message === 'Request END')
    assert.ok(end?.response, 'Request END was not logged')
    return { response, output, lines, end: { ...end, response: end.response } }
}

function capture(result: Awaited<ReturnType<Handler>>, config?: HandlerConfiguration) {
    const received: HttpRequest[] = []
    const handler: HttpHandler = {
        meta: undefined,
        config,
        method: 'POST',
        pathPattern: 'token',
        pathRegExp: /^token/u,
        entry: (_, request) => {
            received.push(request)
            return result
        },
    }
    return { handler, received }
}

function assertNoSecrets(output: string) {
    for (const secret of secrets) {
        assert.equal(output.includes(secret), false, `"${secret}" was logged`)
    }
}

describe('request logging', () => {
    it('redacts credential headers on every line while the handler gets the originals', async () => {
        const headers = {
            Authorization: 'Bearer fake-jwt',
            'proxy-authorization': 'Basic fake-basic',
            'api-key': 'fake-api-key',
            'X-Api-Key': 'fake-x-api-key',
            cookie: 'session=fake-cookie',
            'x-shallow': 'fake-shallow-key',
            'x-webhook-signature': 'fake-signature',
            'user-agent': 'control-agent',
            'x-request-id': 'control-request-id',
        }
        const { handler, received } = capture({
            headers: {
                'set-cookie': 'session=fake-set-cookie',
                'x-signature': 'fake-signature',
                'cache-control': 'no-store',
            },
        })

        const { response, output, lines, end } = await run(handler, {
            uri: 'https://api.example.test/token',
            headers,
        })

        assertNoSecrets(output)
        assert.ok(lines.length > 1)
        for (const line of lines) {
            assert.equal(line.request.headers.Authorization, REDACTED)
            assert.equal(line.request.headers['proxy-authorization'], REDACTED)
            assert.equal(line.request.headers['api-key'], REDACTED)
            assert.equal(line.request.headers['X-Api-Key'], REDACTED)
            assert.equal(line.request.headers.cookie, REDACTED)
            assert.equal(line.request.headers['x-shallow'], REDACTED)
            assert.equal(line.request.headers['x-webhook-signature'], REDACTED)
            assert.equal(line.request.headers['user-agent'], 'control-agent')
            assert.equal(line.request.headers['x-request-id'], 'control-request-id')
        }
        assert.equal(end.response.headers['set-cookie'], REDACTED)
        assert.equal(end.response.headers['x-signature'], REDACTED)
        assert.equal(end.response.headers['cache-control'], 'no-store')
        assert.deepEqual(received[0]?.headers, headers)
        assert.equal(response.headers['set-cookie'], 'session=fake-set-cookie')
    })

    it('redacts nested, array and camelCase body fields on every line', async () => {
        const json: Json = {
            username: 'control-user',
            password: 'fake-password-123',
            profile: {
                refreshToken: 'fake-refresh-token',
                grants: [
                    { access_token: 'fake-access-token' },
                    { clientSecret: 'fake-client-secret' },
                ],
            },
            items: [{ token: 'fake-token', tokenTypeId: 'control-type' }],
        }
        const original = JSON.parse(JSON.stringify(json)) as unknown
        const { handler, received } = capture(undefined)

        const { output, lines } = await run(handler, {
            uri: 'https://api.example.test/token',
            json,
        })

        assertNoSecrets(output)
        for (const line of lines) {
            assert.deepEqual(line.request.json, {
                username: 'control-user',
                password: REDACTED,
                profile: {
                    refreshToken: REDACTED,
                    grants: [{ access_token: REDACTED }, { clientSecret: REDACTED }],
                },
                items: [{ token: REDACTED, tokenTypeId: 'control-type' }],
            })
        }
        assert.deepEqual(received[0]?.body, original)
        assert.deepEqual(json, original)
    })

    it('redacts form-encoded and JSON string bodies of raw-body handlers', async () => {
        const form =
            'grant_type=refresh_token&refresh_token=fake-refresh-token&client_id=control-client&client_secret=fake-client-secret'
        const { handler, received } = capture(undefined, { rawBody: true })

        const { output, end } = await run(handler, {
            uri: 'https://api.example.test/token',
            body: form,
        })

        assertNoSecrets(output)
        assert.equal(
            end.request.body,
            `grant_type=refresh_token&refresh_token=${REDACTED}&client_id=control-client&client_secret=${REDACTED}`,
        )
        assert.equal(received[0]?.body, form)

        const raw = '{"email":"control@example.test","password":"fake-password-123"}'
        const json = await run(capture(undefined, { rawBody: true }).handler, {
            uri: 'https://api.example.test/token',
            body: raw,
        })
        assertNoSecrets(json.output)
        assert.equal(
            json.end.request.body,
            `{"email":"control@example.test","password":"${REDACTED}"}`,
        )
    })

    it('logs a text request body it cannot check as the marker and still runs the handler', async () => {
        const deep = `${'['.repeat(10000)}"control-leaf"${']'.repeat(10000)}`
        const { handler, received } = capture('control-response', { rawBody: true })

        const { response, end } = await run(handler, {
            uri: 'https://api.example.test/token',
            body: deep,
        })

        assert.equal(received[0]?.body, deep)
        assert.equal(response.status, 200)
        assert.equal(response.body, 'control-response')
        assert.equal(end.request.body, REDACTED)
        assert.equal(end.response.body, 'control-response')
    })

    it('logs text response and error bodies it cannot check as the marker and still responds', async () => {
        const deep = `${'['.repeat(10000)}"control-leaf"${']'.repeat(10000)}`

        const text = await run(capture(deep).handler, { uri: 'https://api.example.test/token' })

        assert.equal(text.response.status, 200)
        assert.equal(text.response.body, deep)
        assert.equal(text.end.response.body, REDACTED)

        const failed = await run(
            {
                ...capture(undefined).handler,
                entry: () => {
                    throw Object.assign(new Error('control-message'), {
                        statusCode: 502,
                        body: deep,
                    })
                },
            },
            { uri: 'https://api.example.test/token' },
        )

        assert.equal(failed.response.status, 502)
        assert.equal(failed.response.body, deep)
        assert.equal(failed.end.response.body, REDACTED)
        assert.ok(failed.end.error)
        assert.equal(failed.end.error.message, 'control-message')
        assert.equal(failed.end.error.body, REDACTED)
    })

    it('redacts credential query parameters in the logged URI only', async () => {
        const { handler, received } = capture(undefined)

        const { output, end } = await run(handler, {
            uri: 'https://api.example.test/feed?accessKey=fake-access-key&token=fake-token&key=fake-key&sig=fake-signature&page=2',
        })

        assertNoSecrets(output)
        assert.equal(
            end.request.uri,
            `https://api.example.test/feed?accessKey=${REDACTED}&token=${REDACTED}&key=${REDACTED}&sig=${REDACTED}&page=2`,
        )
        assert.equal(received[0]?.url.query.accessKey, 'fake-access-key')
    })

    it('redacts the response body on Request END but sends the original', async () => {
        const body = {
            access_token: 'fake-access-token',
            refresh_token: 'fake-refresh-token',
            token_type: 'Bearer',
            expires_in: 600,
            integrations: [{ appId: 'control-app', apiSecret: 'fake-api-secret' }],
        }
        const { handler } = capture({ body })

        const { response, output, end } = await run(handler, {
            uri: 'https://api.example.test/token',
        })

        assertNoSecrets(output)
        assert.deepEqual(end.response.body, {
            access_token: REDACTED,
            refresh_token: REDACTED,
            token_type: 'Bearer',
            expires_in: 600,
            integrations: [{ appId: 'control-app', apiSecret: REDACTED }],
        })
        assert.deepEqual(JSON.parse(String(response.body)), body)
    })

    it('redacts text response bodies on Request END but sends the original', async () => {
        const json = '{"access_token":"fake-access-token","token_type":"Bearer"}'
        const plain = await run(capture(json).handler, { uri: 'https://api.example.test/token' })

        assertNoSecrets(plain.output)
        assert.equal(
            plain.end.response.body,
            `{"access_token":"${REDACTED}","token_type":"Bearer"}`,
        )
        assert.equal(plain.response.body, json)

        const form = 'refresh_token=fake-refresh-token&expires_in=600'
        const full = await run(
            capture({
                body: form,
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
            }).handler,
            { uri: 'https://api.example.test/token' },
        )

        assertNoSecrets(full.output)
        assert.equal(full.end.response.body, `refresh_token=${REDACTED}&expires_in=600`)
        assert.equal(full.response.body, form)
    })

    it('redacts error response bodies, and leaves them out when excluded', async () => {
        const handler: HttpHandler = {
            ...capture(undefined).handler,
            entry: () => {
                throw Object.assign(new Error('Bad request'), {
                    statusCode: 400,
                    body: { message: 'control-message', token: 'fake-token' },
                })
            },
        }

        const { response, output, end } = await run(handler, {
            uri: 'https://api.example.test/token',
        })

        assertNoSecrets(output)
        assert.equal(end.response.status, 400)
        assert.equal(end.response.body, `{"message":"control-message","token":"${REDACTED}"}`)
        assert.equal(response.body, '{"message":"control-message","token":"fake-token"}')

        const excluded = await run(
            { ...handler, config: { excludeBodyFromLogs: true } },
            { uri: 'https://api.example.test/token' },
        )
        assert.equal(excluded.end.response.status, 400)
        assert.equal(excluded.end.response.body, undefined)
        assert.equal(excluded.output.includes('control-message'), false)
    })

    it('redacts the bodies that the error of a failed request carries, and leaves them out when excluded', async () => {
        const thrown = Object.assign(new Error('Upstream call failed'), {
            statusCode: 502,
            body: { message: 'control-message', newPassword: 'fake-new-password' },
            response: {
                status: 401,
                body: '{"error":"control-error","client_secret":"fake-client-secret"}',
            },
        })
        const handler: HttpHandler = {
            ...capture(undefined).handler,
            entry: () => {
                throw thrown
            },
        }

        const { output, end } = await run(handler, { uri: 'https://api.example.test/token' })

        assertNoSecrets(output)
        assert.equal(end.response.status, 502)
        assert.equal(end.response.body, `{"message":"control-message","newPassword":"${REDACTED}"}`)
        assert.ok(end.error)
        assert.equal(end.error.message, 'Upstream call failed')
        assert.deepEqual(end.error.body, { message: 'control-message', newPassword: REDACTED })
        assert.deepEqual(end.error.response, {
            status: 401,
            body: `{"error":"control-error","client_secret":"${REDACTED}"}`,
        })

        const excluded = await run(
            { ...handler, config: { excludeBodyFromLogs: true } },
            { uri: 'https://api.example.test/token' },
        )

        assertNoSecrets(excluded.output)
        assert.equal(excluded.output.includes('control-message'), false)
        assert.equal(excluded.output.includes('control-error'), false)
        assert.equal(excluded.end.response.body, undefined)
        assert.ok(excluded.end.error)
        assert.equal(excluded.end.error.message, 'Upstream call failed')
        assert.equal(excluded.end.error.body, undefined)
        assert.deepEqual(excluded.end.error.response, { status: 401 })
        assert.equal(thrown.response.body.includes('fake-client-secret'), true)
        assert.equal(thrown.body.newPassword, 'fake-new-password')
    })

    it('leaves request and response bodies out when the handler excludes them', async () => {
        const { handler, received } = capture(
            { body: { access_token: 'fake-access-token' } },
            {
                excludeBodyFromLogs: true,
            },
        )

        const { output, lines, end } = await run(handler, {
            uri: 'https://api.example.test/token',
            json: { username: 'control-user', password: 'fake-password-123' },
        })

        assertNoSecrets(output)
        assert.equal(output.includes('control-user'), false)
        for (const line of lines) {
            assert.equal(line.request.json, undefined)
        }
        assert.equal(end.response.status, 200)
        assert.equal(end.response.body, undefined)
        assert.deepEqual(received[0]?.body, {
            username: 'control-user',
            password: 'fake-password-123',
        })
    })

    it('leaves bodies out when the package config excludes them', async () => {
        // Package config only reaches handlers registered after their package's metadata is set.
        setMeta('test-package', 'packageConfig', undefined, { excludeBodyFromLogs: true })
        post('package-config', () => ({ body: { access_token: 'fake-access-token' } }))
        const handlers = getHandlers('http')
        const handler = handlers[handlers.length - 1]
        assert.ok(handler)

        const { output, lines, end } = await run(handler, {
            uri: 'https://api.example.test/package-config',
            json: { username: 'control-user', password: 'fake-password-123' },
        })

        assertNoSecrets(output)
        assert.equal(output.includes('control-user'), false)
        for (const line of lines) {
            assert.equal(line.request.json, undefined)
        }
        assert.equal(end.response.status, 200)
        assert.equal(end.response.body, undefined)
    })
})
