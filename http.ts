import type { UrlWithParsedQuery } from 'node:url'
import { Context, HandlerConfiguration, Json } from './context.js'
import { registerHttpHandler } from './host/registry.js'

export * from './context.js'

export type ResponseHeaders = {
    [key: string]: string
}

export type FullResult = {
    headers?: ResponseHeaders
    status?: number
    body?: unknown
}

export type Result = void | string | FullResult

export type HttpRequest = {
    readonly rawUrl: string
    readonly url: Readonly<UrlWithParsedQuery> & { pathStepAt: (index: number) => string }
    readonly headers: Readonly<ResponseHeaders>
    readonly body?: Json | string
}

export type HttpHandlerConfiguration = HandlerConfiguration & {
    /**
     * A string identifying which domains can access the endpoint cross-origin.
     * @default undefined
     */
    readonly cors?: string
}

export type Handler = (context: Context, request: HttpRequest) => Promise<Result> | Result

export function get(path: string, fn: Handler): void
export function get(path: string, config: HttpHandlerConfiguration, fn: Handler): void
export function get(
    path: string,
    configOrHandler: HttpHandlerConfiguration | Handler,
    fn?: Handler,
): void {
    console.log('Register GET handler', path)
    registerHttpHandler('GET', path, configOrHandler, fn)
}
export function post(path: string, fn: Handler): void
export function post(path: string, config: HttpHandlerConfiguration, fn: Handler): void
export function post(
    path: string,
    configOrHandler: HttpHandlerConfiguration | Handler,
    fn?: Handler,
): void {
    console.log('Register POST handler', path)
    registerHttpHandler('POST', path, configOrHandler, fn)
}
export function put(path: string, fn: Handler): void
export function put(path: string, config: HttpHandlerConfiguration, fn: Handler): void
export function put(
    path: string,
    configOrHandler: HttpHandlerConfiguration | Handler,
    fn?: Handler,
): void {
    console.log('Register PUT handler', path)
    registerHttpHandler('PUT', path, configOrHandler, fn)
}
export function patch(path: string, fn: Handler): void
export function patch(path: string, config: HttpHandlerConfiguration, fn: Handler): void
export function patch(
    path: string,
    configOrHandler: HttpHandlerConfiguration | Handler,
    fn?: Handler,
): void {
    console.log('Register PATCH handler', path)
    registerHttpHandler('PATCH', path, configOrHandler, fn)
}
export function del(path: string, fn: Handler): void
export function del(path: string, config: HttpHandlerConfiguration, fn: Handler): void
export function del(
    path: string,
    configOrHandler: HttpHandlerConfiguration | Handler,
    fn?: Handler,
): void {
    console.log('Register DELETE handler', path)
    registerHttpHandler('DELETE', path, configOrHandler, fn)
}
