import { HandlerConfiguration } from '../context.js'
import { Handler } from '../http.js'

export type HttpHandler = {
    meta: Metadata | undefined
    config: (PackageConfiguration & HandlerConfiguration) | undefined
    method: Method
    pathPattern: string
    pathRegExp: RegExp
    entry: Handler
}

type HandlerTypes = {
    http: HttpHandler
}

const handlers: { [key: string]: unknown[] } = {}

function addHandler(type: keyof HandlerTypes, handler: HttpHandler) {
    ;(handlers[type] ??= []).push(handler)
}

export function getHandlers(type: keyof HandlerTypes) {
    return (handlers[type] ?? []) as HttpHandler[]
}

type HttpHost = (
    meta: Metadata | undefined,
    config: HandlerConfiguration | undefined,
    method: Method,
    path: string,
    handler: Handler,
) => void

let httpHostRegistry: HttpHost

function setHttpHost(host: HttpHost) {
    httpHostRegistry = host
}

let metadata: Metadata | undefined

export function setMeta(
    packageName: string,
    fileName: string,
    revision: string | undefined,
    config: PackageConfiguration | undefined,
) {
    metadata = {
        packageName,
        fileName,
        revision,
        config,
    }
}

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export type PackageConfiguration = HandlerConfiguration & {
    // Placeholder for package-level configurations
}

export type Metadata = {
    packageName: string
    fileName: string
    revision: string | undefined
    config?: PackageConfiguration
}

function getMetadata() {
    return metadata
}

function pathToRegExp(path: string) {
    return new RegExp(
        (
            '^' +
            path.replace(/[/\\^$+?.()|[\]{}]/gu, '\\$&').replaceAll('*', '[^/\\?]+') +
            '(\\?.*)?$'
        ).replace('[^/\\?]+[^/\\?]+(\\?.*)?$', ''),
        'u',
    )
}

function combineConfig(
    base: PackageConfiguration | undefined,
    override: HandlerConfiguration | undefined,
): (PackageConfiguration & HandlerConfiguration) | undefined {
    if (base === undefined) {
        return override
    } else if (override === undefined) {
        return base
    }
    return { ...base, ...override }
}

function httpHost(
    meta: Metadata | undefined,
    cfg: HandlerConfiguration | undefined,
    method: Method,
    path: string,
    entry: Handler,
) {
    addHandler('http', {
        meta,
        config: combineConfig(meta?.config, cfg),
        method,
        pathPattern: path,
        pathRegExp: pathToRegExp(path),
        entry,
    })
}

setHttpHost(httpHost)

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export function registerHttpHandler(
    method: Method,
    path: string,
    configOrHandler: HandlerConfiguration | Handler,
    fn?: Handler,
): void {
    if (typeof configOrHandler === 'function') {
        httpHostRegistry(getMetadata(), undefined, method, path, configOrHandler)
    } else {
        if (!fn) {
            throw new Error('Please provide a handler function.')
        }
        httpHostRegistry(getMetadata(), configOrHandler, method, path, fn)
    }
}
