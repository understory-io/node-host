export const REDACTED = '[REDACTED]'

/**
 * A body field, log field or query parameter is sensitive when its name, lower-cased and without
 * `_` and `-`, ends with one of these.
 *
 * Services spell the same credential `refresh_token`, `refreshToken` or `Refresh-Token`, and
 * qualify it (`newPassword`, `clientSecret`, `SERVICE_API_KEY`). Matching the end of the name
 * covers all of those, while names that only describe a credential, such as `token_type`,
 * `passwordChanged` or `accessKeyId`, stay readable.
 */
export const SENSITIVE_FIELD_SUFFIXES: readonly string[] = [
    'password',
    'secret',
    'token',
    'apikey',
    'accesskey',
    'privatekey',
]

const sensitiveFieldName = new RegExp(`(?:${SENSITIVE_FIELD_SUFFIXES.join('|')})$`, 'u')

function normalizeName(name: string) {
    return name.toLowerCase().replace(/[-_]/gu, '')
}

export function isSensitiveField(name: string) {
    return sensitiveFieldName.test(normalizeName(name))
}

/**
 * The `JSON.stringify` replacer for everything that is logged, so credentials are hidden at any
 * depth, whichever code put them into a log entry.
 *
 * Absent and `null` values are kept: they carry no secret and show that a credential was missing.
 */
export function redactingReplacer(key: string, value: unknown): unknown {
    if (value !== undefined && value !== null && isSensitiveField(key)) {
        return REDACTED
    }
    // Messages of some RPC frameworks hold 64-bit integers as BigInt, which JSON.stringify rejects.
    return typeof value === 'bigint' ? value.toString() : value
}

/**
 * A raw body as it may be logged. Object bodies need no counterpart, because the logger redacts
 * them when it serializes the entry.
 *
 * Raw-body handlers, such as an OAuth token endpoint, and upstream error responses hold their
 * credentials in JSON or form-encoded text. Text with nothing to hide is returned unchanged, so
 * it is logged byte for byte.
 */
export function redactText(text: string) {
    const json = parseJson(text)
    if (typeof json === 'object' && json !== null) {
        const { redacted, changed } = stringifyRedacted(json)
        return changed ? redacted : text
    }
    return redactFormEncoded(text)
}

function stringifyRedacted(value: object) {
    let changed = false
    const redacted = JSON.stringify(value, (key: string, v: unknown) => {
        const replaced = redactingReplacer(key, v)
        changed ||= replaced !== v
        return replaced
    })
    return { redacted, changed }
}

function redactFormEncoded(text: string) {
    if (!text.includes('=')) {
        return text
    }
    return text
        .split('&')
        .map(pair => {
            const separator = pair.indexOf('=')
            if (
                separator < 0 ||
                !isSensitiveField(decodeFormComponent(pair.substring(0, separator)))
            ) {
                return pair
            }
            return `${pair.substring(0, separator)}=${REDACTED}`
        })
        .join('&')
}

function decodeFormComponent(component: string) {
    try {
        return decodeURIComponent(component.replace(/\+/gu, ' '))
    } catch {
        return component
    }
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown
    } catch {
        return undefined
    }
}
