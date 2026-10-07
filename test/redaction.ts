import assert from 'node:assert/strict'
import {
    isSensitiveField,
    isSensitiveQueryParameter,
    REDACTED,
    redactHeaders,
    redactingReplacer,
    redactText,
    redactUri,
    SENSITIVE_FIELD_SUFFIXES,
} from '../host/redaction.js'

const sensitiveNames = [
    'password',
    'PASSWORD',
    'newPassword',
    'refresh_token',
    'refreshToken',
    'Refresh-Token',
    'access_token',
    'accessToken',
    'id_token',
    'client_secret',
    'clientSecret',
    'apiSecret',
    'appSecret',
    'secretToken',
    'agreementGrantToken',
    'nextToken',
    'token',
    'Token',
    'api_key',
    'apiKey',
    'x-api-key',
    'accessKey',
    'privateKey',
    'SIGNING_PRIVATE_KEY',
    'WEBHOOK_SECRET',
    'SESSION_TOKEN',
    'SERVICE_API_KEY',
    'Authorization',
    'proxy-authorization',
    'Cookie',
    'set-cookie',
    'setCookie',
    'X-Shallow',
]

const readableNames = [
    'username',
    'grant_type',
    'token_type',
    'tokenTypeId',
    'accessTokenExpiresAt',
    'passwordChanged',
    'secretName',
    'accessKeyId',
    'publicKey',
    'apiKeyId',
    'measurementId',
    'client_id',
    'expires_in',
    'key',
    'code',
    'signature',
    'NODE_ENV',
    'authorizationUrl',
    'cookieConsent',
    'shallow',
]

describe('redaction', () => {
    it('matches field names by their normalized ending or as credential headers', () => {
        for (const name of sensitiveNames) {
            assert.equal(isSensitiveField(name), true, name)
        }
        for (const name of readableNames) {
            assert.equal(isSensitiveField(name), false, name)
        }
        for (const suffix of SENSITIVE_FIELD_SUFFIXES) {
            assert.equal(isSensitiveField(suffix), true, suffix)
        }
    })

    it('also matches bearer-value names in query parameters only', () => {
        for (const name of [...sensitiveNames, 'key', 'Key', 'code', 'sig', 'signature']) {
            assert.equal(isSensitiveQueryParameter(name), true, name)
        }
        for (const name of ['page', 'keyId', 'code_challenge', 'client_id', 'token_type']) {
            assert.equal(isSensitiveQueryParameter(name), false, name)
        }
    })

    it('redacts credential headers case-insensitively', () => {
        const headers = {
            Authorization: 'Bearer fake-jwt',
            'proxy-authorization': 'Basic fake-basic',
            'api-key': 'fake-api-key',
            'X-Api-Key': 'fake-x-api-key',
            cookie: 'session=fake-cookie',
            'set-cookie': 'session=fake-set-cookie',
            'x-shallow': 'fake-shallow-key',
            'user-agent': 'control-agent',
            'x-request-id': 'control-request-id',
        }

        const redacted = redactHeaders(headers)

        assert.deepEqual(redacted, {
            Authorization: REDACTED,
            'proxy-authorization': REDACTED,
            'api-key': REDACTED,
            'X-Api-Key': REDACTED,
            cookie: REDACTED,
            'set-cookie': REDACTED,
            'x-shallow': REDACTED,
            'user-agent': 'control-agent',
            'x-request-id': 'control-request-id',
        })
        assert.equal(headers.Authorization, 'Bearer fake-jwt')
    })

    it('redacts nested fields and array items while serializing, without touching the original', () => {
        const value = {
            username: 'control-user',
            password: 'fake-password-123',
            nested: {
                refreshToken: 'fake-refresh-token',
                list: [
                    { 'Access-Token': 'fake-access-token' },
                    { apiSecret: 'fake-api-secret', appId: 'control-id' },
                ],
            },
            items: [{ token: { value: 'fake-token-object' }, tokenTypeId: 'control-type' }],
            missing: { password: null, token: undefined },
            amount: BigInt(42),
        }

        assert.deepEqual(JSON.parse(JSON.stringify(value, redactingReplacer)), {
            username: 'control-user',
            password: REDACTED,
            nested: {
                refreshToken: REDACTED,
                list: [{ 'Access-Token': REDACTED }, { apiSecret: REDACTED, appId: 'control-id' }],
            },
            items: [{ token: REDACTED, tokenTypeId: 'control-type' }],
            missing: { password: null },
            amount: '42',
        })
        assert.equal(value.password, 'fake-password-123')
        assert.deepEqual(value.nested.list[1], {
            apiSecret: 'fake-api-secret',
            appId: 'control-id',
        })
    })

    it('redacts JSON and form-encoded text', () => {
        assert.equal(
            redactText('{"email":"control@example.test","newPassword":"fake-password-123"}'),
            `{"email":"control@example.test","newPassword":"${REDACTED}"}`,
        )
        assert.equal(
            redactText(
                'grant_type=refresh_token&refresh%5FToken=fake-refresh-token&client_id=control-client&client_secret=fake%2BSecret',
            ),
            `grant_type=refresh_token&refresh%5FToken=${REDACTED}&client_id=control-client&client_secret=${REDACTED}`,
        )
    })

    it('leaves text without credentials byte-identical', () => {
        const pretty = '{\n  "email": "control@example.test"\n}'
        assert.equal(redactText(pretty), pretty)
        assert.equal(redactText('{"token":null}'), '{"token":null}')
        assert.equal(redactText('plain text, a=b'), 'plain text, a=b')
        assert.equal(
            redactText('key=control-key&code=control-code'),
            'key=control-key&code=control-code',
        )
        assert.equal(redactText(''), '')
    })

    it('redacts credential query parameters in a URI', () => {
        assert.equal(
            redactUri(
                'https://api.example.test/feeds?accessKey=fake-access-key&page=2&access_token=fake-access-token&key=fake-key&Sig=fake-sig#top',
            ),
            `https://api.example.test/feeds?accessKey=${REDACTED}&page=2&access_token=${REDACTED}&key=${REDACTED}&Sig=${REDACTED}#top`,
        )
        const control = 'https://api.example.test/feeds?page=2&keyId=control-key-id'
        assert.equal(redactUri(control), control)
        assert.equal(redactUri('https://api.example.test/feeds'), 'https://api.example.test/feeds')
    })
})
