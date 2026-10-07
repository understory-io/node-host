import assert from 'node:assert/strict'
import {
    isSensitiveField,
    REDACTED,
    redactingReplacer,
    redactText,
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
]

describe('redaction', () => {
    it('matches field names by their normalized ending', () => {
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
})
