import express from 'express';
import type { Express } from 'express';

/**
 * Captures every route registration performed while building an app by
 * temporarily instrumenting the Router/Route prototypes, then resolves
 * absolute paths by walking the recorded mount graph from the app's root
 * router. ':param' segments are normalized to '{param}' for OpenAPI
 * comparison.
 */

export interface LiveRoute {
    method: string
    path: string
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function joinPaths(prefix: string, path: string): string {
    const left = prefix === '/' ? '' : prefix;
    const right = path.startsWith('/') ? path : `/${path}`;
    const joined = `${left}${right}`;
    return joined.length > 1 ? joined.replace(/\/+$/, '') : '/';
}

function normalizeParams(path: string): string {
    return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

export function collectLiveRoutes(buildApp: () => Express): LiveRoute[] {
    // router instance -> its directly registered routes
    const routesByRouter = new Map<unknown, LiveRoute[]>();
    // [parent router, mount path, child router]
    const mounts: Array<{ parent: unknown; path: string; child: unknown }> = [];
    // Route instance -> { router, path }
    const routeOwners = new Map<unknown, { router: unknown; path: string }>();

    const routerProto = (express.Router as unknown as { prototype: Record<string, (...args: unknown[]) => unknown> }).prototype;
    const RouteCtor = (express.Router as unknown as { Route: { prototype: Record<string, (...args: unknown[]) => unknown> } }).Route;
    const routeProto = RouteCtor.prototype;

    const originals = new Map<string, (...args: unknown[]) => unknown>();

    const install = (): void => {
        const useOriginal = routerProto.use;
        originals.set('use', useOriginal);
        routerProto.use = function patchedUse(this: unknown, ...args: unknown[]) {
            let mountPath = '/';
            let startAt = 0;
            if (typeof args[0] === 'string') {
                mountPath = args[0];
                startAt = 1;
            }
            for (let i = startAt; i < args.length; i += 1) {
                const candidate = args[i];
                if (typeof candidate === 'function' && Array.isArray((candidate as { stack?: unknown[] }).stack)) {
                    mounts.push({ parent: this, path: mountPath, child: candidate });
                }
            }
            return useOriginal.apply(this, args);
        };

        const routeOriginal = routerProto.route;
        originals.set('route', routeOriginal);
        routerProto.route = function patchedRoute(this: unknown, ...args: unknown[]) {
            const route = routeOriginal.apply(this, args);
            const path = typeof args[0] === 'string' ? args[0] : '/';
            routeOwners.set(route, { router: this, path });
            return route;
        };

        for (const method of HTTP_METHODS) {
            const original = routeProto[method];
            originals.set(method, original);
            routeProto[method] = function patchedRouteMethod(this: unknown, ...args: unknown[]) {
                const owner = routeOwners.get(this);
                if (owner) {
                    const entry = { method: method.toUpperCase(), path: normalizeParams(owner.path) };
                    const list = routesByRouter.get(owner.router) ?? [];
                    list.push(entry);
                    routesByRouter.set(owner.router, list);
                }
                return original.apply(this, args);
            };
        }
    };

    const restore = (): void => {
        routerProto.use = originals.get('use')!;
        routerProto.route = originals.get('route')!;
        for (const method of HTTP_METHODS) {
            routeProto[method] = originals.get(method)!;
        }
    };

    install();
    let app: Express;
    try {
        app = buildApp();
    } finally {
        restore();
    }

    // Resolve absolute paths from the root router over the mount graph.
    const rootRouter = (app as unknown as { router?: unknown }).router;
    const seen = new Set<unknown>();
    const resolved = new Set<string>();
    const queue: Array<{ node: unknown; prefix: string }> = [{ node: rootRouter, prefix: '/' }];

    while (queue.length > 0) {
        const { node, prefix } = queue.shift()!;
        if (seen.has(node)) {
            continue;
        }
        seen.add(node);

        for (const route of routesByRouter.get(node) ?? []) {
            resolved.add(`${route.method} ${joinPaths(prefix, route.path)}`);
        }
        for (const mount of mounts) {
            if (mount.parent === node && !seen.has(mount.child)) {
                queue.push({ node: mount.child, prefix: joinPaths(prefix, mount.path) });
            }
        }
    }

    return [...resolved].map((entry) => {
        const spaceIndex = entry.indexOf(' ');
        return { method: entry.slice(0, spaceIndex), path: entry.slice(spaceIndex + 1) };
    });
}
