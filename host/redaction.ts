export const REDACTED = '[REDACTED]'

/**
 * A body field, log field or query parameter is sensitive when its name, lower-cased and without
 * `_` and `-`, ends with one of these, or is the name of a credential header.
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

// These carry bearer values in URLs, but as body or log fields they are too generic to hide.
const SENSITIVE_QUERY_PARAMETERS: readonly string[] = ['key', 'code', 'sig', 'signature']

// Headers that carry nothing but a credential. Code that copies headers into a log entry, such
// as the request configuration that HTTP clients attach to their errors, keeps their names as
// field names, so fields with these names are redacted too.
const CREDENTIAL_HEADERS: readonly string[] = [
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-shallow',
]

// Every log entry of a request carries its headers, so credentials sent as
// headers (internal api-key, bearer tokens, webhook signatures) would otherwise
// end up in plaintext in every log line, at every level.
const credentialHeader = CREDENTIAL_HEADERS.join('|')
const sensitiveHeader = new RegExp(
    `^(?:${credentialHeader})$|api[-_]?key|token|secret|password|signature|checksum|hmac|-sig$`,
    'iu',
)

const sensitiveFieldName = new RegExp(`(?:${SENSITIVE_FIELD_SUFFIXES.join('|')})$`, 'u')
const credentialHeaderFields = new Set(CREDENTIAL_HEADERS.map(normalizeName))
const sensitiveQueryParameters = new Set(SENSITIVE_QUERY_PARAMETERS)

function normalizeName(name: string) {
    return name.toLowerCase().replace(/[-_]/gu, '')
}

export function isSensitiveField(name: string) {
    const normalized = normalizeName(name)
    return sensitiveFieldName.test(normalized) || credentialHeaderFields.has(normalized)
}

export function isSensitiveQueryParameter(name: string) {
    return isSensitiveField(name) || sensitiveQueryParameters.has(normalizeName(name))
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

export function redactHeaders<T extends { readonly [key: string]: string } | undefined>(
    headers: T,
): T {
    if (!headers) {
        return headers
    }
    return Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [
            name,
            sensitiveHeader.test(name) ? REDACTED : value,
        ]),
    ) as T
}

/**
 * A raw body as it may be logged. Object bodies need no counterpart, because the logger redacts
 * them when it serializes the entry.
 *
 * Raw-body handlers, such as an OAuth token endpoint, and upstream error responses hold their
 * credentials in JSON or form-encoded text. Text with nothing to hide is returned unchanged, so
 * it is logged byte for byte.
 *
 * The text comes from clients and upstream services, and logging it must not fail the request.
 * Text that cannot be checked, such as JSON nested too deeply to serialize again, is logged as
 * the marker.
 */
export function redactText(text: string) {
    try {
        const json = parseJson(text)
        if (typeof json === 'object' && json !== null) {
            const { redacted, changed } = stringifyRedacted(json)
            return changed ? redacted : text
        }
        return redactFormEncoded(text, isSensitiveField)
    } catch {
        return REDACTED
    }
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

export function redactUri(uri: string) {
    const queryStart = uri.indexOf('?')
    if (queryStart < 0) {
        return uri
    }
    const hashStart = uri.indexOf('#', queryStart)
    const queryEnd = hashStart < 0 ? uri.length : hashStart
    return (
        uri.substring(0, queryStart + 1) +
        redactFormEncoded(uri.substring(queryStart + 1, queryEnd), isSensitiveQueryParameter) +
        uri.substring(queryEnd)
    )
}

function redactFormEncoded(text: string, isSensitive: (name: string) => boolean) {
    if (!text.includes('=')) {
        return text
    }
    return text
        .split('&')
        .map(pair => {
            const separator = pair.indexOf('=')
            if (separator < 0 || !isSensitive(decodeFormComponent(pair.substring(0, separator)))) {
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
