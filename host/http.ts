import { parse, UrlWithParsedQuery } from 'node:url'
import { Context, measure } from '../context.js'
import type { Json, ResponseHeaders, Result } from '../http.js'
import { ClientInfo, RootLogger } from './context.js'
import type { HttpHandler } from './registry.js'

export type Response = {
    headers: { readonly [key: string]: string }
    status: number
    body?: string | Buffer
    isBase64Encoded?: boolean
}

type RequestOptions = BodylessRequestOptions | StringRequestOptions | JsonRequestOptions

type BodylessRequestOptions = {
    uri: string
    headers?: { readonly [key: string]: string }
}

type StringRequestOptions = BodylessRequestOptions & {
    body: string
}

type JsonRequestOptions = BodylessRequestOptions & {
    json: Json
}

export async function executeRequest(
    log: RootLogger,
    context: Omit<Context, 'log'>,
    handler: HttpHandler,
    options: RequestOptions,
    success: () => Promise<unknown>,
    rethrow: boolean = true
): Promise<Response> {
    const isShallow =
        context.env.SHALLOW_KEY && options.headers?.['x-shallow'] === context.env.SHALLOW_KEY
    const includeBodyInLogs = !handler.config?.excludeBodyFromLogs
    const logRequest = includeBodyInLogs
        ? { method: handler.method, ...options }
        : withoutRequestBody({ method: handler.method, ...options })
    log = log.enrichReserved({ meta: context.meta, request: logRequest })
    if (isShallow) {
        log.trace('Shallow request')
        return {
            headers: {},
            status: 204,
        }
    }
    log.trace('Request BEGIN')
    try {
        let parsedUrl: UrlWithParsedQuery & { pathStepAt: (index: number) => string }
        let pathSteps: string[]
        const req = {
            rawUrl: options.uri,
            get url() {
                return (parsedUrl ??= {
                    ...parse(this.rawUrl, true),
                    pathStepAt: (index: number) => {
                        const steps = (pathSteps ??= parsedUrl.pathname?.split('/') ?? [])
                        const step = steps[index + 1]
                        if (!step) {
                            throw new RangeError(`Path does not have a step at index ${index}.`)
                        }
                        return step
                    },
                })
            },
            body: requestBody(options),
            headers: options.headers ?? {},
        }

        const result = await measure(log, 'execution', () =>
            handler.entry({ ...context, log }, req),
        )

        const response = resultToResponse(result, includeBodyInLogs)

        if (context.signal.aborted) {
            response.headers = {
                'x-timeout': '1',
                ...response.headers,
            }
        }

        log = log.enrichReserved({
            response: {
                status: response.status,
                headers: response.headers,
                body: response.logBody,
            },
        })
        if (response.status < 300) {
            log.debug('Request END')
            await success()
        } else {
            log.warn('Request END')
        }
        return response
    } catch (e) {
        try {
            const response = errorToResponse(e)
            log = log.enrichReserved({ response })
            log.error('Request END', e)

            // If we do not want to rethrow errors, ie. for production environments,
            // we should return the generated response code.
            // For any others where we do wish to rethrow, we only do it for 500 Internal Server Error
            // status codes, as any other code is assumed to be OK, and we do not want change a
            // 404 Not Found or 400 Bad Request into a 500 Internal Server Error, which Lambda would
            // otherwise return "on error".
            if(!rethrow || rethrow && response.status !== 500){
                return response
            }
        } catch (convertError) {
            log.error('Could not convert exception to error response.', convertError)
            return {
                headers: {},
                status: 500,
            }
        }
        throw e
    }
}

function resultToResponse(result: Result, withLogBody: boolean): Response & { logBody?: unknown } {
    if (!result) {
        return {
            headers: {},
            status: 204,
        }
    } else if (typeof result === 'string') {
        const logBody = withLogBody ? result : undefined
        return {
            headers: {
                'content-type': 'text/plain',
            },
            status: 200,
            body: result,
            logBody,
        }
    } else {
        if (result.body === undefined) {
            return {
                headers: result.headers ?? {},
                status: result.status ?? 200,
            }
        } else if (typeof result.body === 'string') {
            const logBody = withLogBody ? result.body : undefined
            return {
                headers: withContentType(result.headers, 'text/plain'),
                status: result.status ?? 200,
                body: result.body,
                logBody,
                isBase64Encoded: result.isBase64Encoded,
            }
        } else if (Buffer.isBuffer(result.body)) {
            const logBody = withLogBody ? result.body.toString('base64') : undefined
            return {
                headers: withContentType(result.headers, 'application/octet-stream'),
                status: result.status ?? 200,
                body: result.body,
                logBody,
                isBase64Encoded: result.isBase64Encoded,
            }
        } else {
            const logBody = withLogBody ? result.body : undefined
            return {
                headers: withContentType(result.headers, 'application/json'),
                status: result.status ?? 200,
                body: JSON.stringify(result.body),
                logBody,
            }
        }
    }
}

function withoutRequestBody(options: RequestOptions & { method: string }) {
    if (hasJsonBody(options)) {
        const { json, ...bodyless } = options
        return bodyless
    }
    if (hasStringBody(options)) {
        const { body, ...bodyless } = options
        return bodyless
    }
    return options
}

function requestBody(options: RequestOptions): Json | string | undefined {
    if (hasJsonBody(options)) {
        return options.json
    }
    if (hasStringBody(options)) {
        return options.body
    }
    return undefined
}

function hasJsonBody(options: RequestOptions): options is JsonRequestOptions {
    return (options as { json?: unknown }).json !== undefined
}

function hasStringBody(options: RequestOptions): options is StringRequestOptions {
    return (options as { body?: unknown }).body !== undefined
}

function withContentType(headers: ResponseHeaders | undefined, contentType: string) {
    if (!headers) {
        return {
            'content-type': contentType,
        }
    }
    if (!headers['content-type']) {
        headers['content-type'] = contentType
    }
    return headers
}

function errorToResponse(e: unknown): Response {
    const { body, statusCode: status } = e as { body?: unknown; statusCode?: number }
    if (typeof body === 'string') {
        return {
            headers: {
                'content-type': 'text/plain',
            },
            status: status ?? 500,
            body,
        }
    } else if (typeof body === 'object') {
        return {
            headers: {
                'content-type': 'application/json',
            },
            status: status ?? 500,
            body: JSON.stringify(body),
        }
    } else {
        return {
            headers: {},
            status: status ?? 500,
        }
    }
}

export function clientFromHeaders(
    headers: { readonly [key: string]: string } | undefined,
): ClientInfo {
    if (!headers) {
        return {}
    }
    return {
        operationId: headers['x-request-id'] ?? headers['request-id'],
        clientId:
            headers['x-client-id'] ??
            headers['x-installation-id'] ??
            headers['client-id'] ??
            headers['installation-id'],
        clientIp: headers['x-forwarded-for'],
        userAgent: headers['x-forwarded-for-user-agent'] ?? headers['user-agent'],
    }
}
