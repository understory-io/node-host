import { readdir, readFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HttpHandlerConfiguration } from '../http.js'
import { PackageConfiguration } from './registry.js'

type CPU =
    | 'arm'
    | 'arm64'
    | 'ia32'
    | 'mips'
    | 'mipsel'
    | 'ppc'
    | 'ppc64'
    | 's390'
    | 's390x'
    | 'x32'
    | 'x64'
type CpuConfig = CPU | `!${CPU}`
type OSConfig = NodeJS.Platform | `!${NodeJS.Platform}`

export interface PackageJsonConfiguration {
    nodeVersion?: string
    cpus?: CpuConfig[]
    os?: OSConfig[]
}

export interface Reflection {
    name: string
    http: {
        name: string
        method: string
        pathPattern: string
        pathRegExp: RegExp
        config: HttpHandlerConfiguration & PackageJsonConfiguration
    }[]
}

export function resolveCpu(config: PackageJsonConfiguration, supported: CPU[]): CPU {
    const resolved = resolve(config.cpus, supported)
    if (!resolved) {
        // resolve<T>(config, supported) actually asserts config is (T | `!${T}`)[], but that's not supported yet.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        throw new Error('Unsupported CPUs: ' + config.cpus!.join(', '))
    }
    return resolved
}

export function resolveOS(
    config: PackageJsonConfiguration,
    supported: NodeJS.Platform[],
): NodeJS.Platform {
    const resolved = resolve(config.os, supported)
    if (!resolved) {
        // resolve<T>(config, supported) actually asserts config is (T | `!${T}`)[], but that's not supported yet.
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        throw new Error('Unsupported operating systems: ' + config.os!.join(', '))
    }
    return resolved
}

function resolve<T extends string>(
    config: (T | `!${T}`)[] | undefined,
    supported: T[],
): T | undefined {
    if (!config) {
        return supported[0]
    }
    return supported.find(s => config.includes(s) && !config.includes(`!${s}`))
}

export async function reflect(path: string): Promise<Reflection> {
    const packageJson = await readConfig()
    const files = (await readdir(path)).filter(
        file => extname(file) === '.ts' && !file.endsWith('.d.ts'),
    )
    const { getHandlers, setMeta } = (await import(
        pathToFileURL(
            join(process.cwd(), 'node_modules/@riddance/host/host/registry.js'),
        ).toString()
    )) as {
        getHandlers: (type: string) => {
            name: string
            meta?: { fileName: string }
            config: HttpHandlerConfiguration
            method: string
            pathPattern: string
            pathRegExp: RegExp
        }[]
        setMeta: (
            packageName: string,
            fileName: string,
            rev: string | undefined,
            cfg: PackageConfiguration | undefined,
        ) => void
    }

    for (const file of files) {
        const base = basename(file, '.ts')
        setMeta(packageJson.name, base, undefined, packageJson.config)
        await import(pathToFileURL(join(process.cwd(), path, base + '.js')).toString())
    }

    return {
        name: packageJson.name,
        http: getHandlers('http').map(h => ({
            config: {
                ...h.config,
                cpus: packageJson.cpu,
                os: packageJson.os,
                nodeVersion: packageJson.engines?.node,
            },
            name: h.meta?.fileName ?? '',
            method: h.method,
            pathPattern: h.pathPattern,
            pathRegExp: h.pathRegExp,
        })),
    }
}

async function readConfig() {
    const packageJson = JSON.parse(await readFile('package.json', 'utf-8')) as {
        name: string
        engines?: { [engine: string]: string }
        cpu?: CpuConfig[]
        os?: OSConfig[]
        config?: object
    }
    return packageJson
}
