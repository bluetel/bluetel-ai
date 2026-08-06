import { SISYPHUS_TRPC_ENDPOINT } from '@bluetel-ai/sisyphus-api/client'

/**
 * The origin the tRPC client should call.
 *
 * In the browser the current origin is authoritative — a preview deployment, a tunnel or a
 * custom domain all have to talk to themselves, and a configured absolute URL would send them
 * somewhere else. On the server there is no origin to read, so the configured site URL is used;
 * `httpBatchLink` needs an absolute URL there.
 *
 * The site URL is passed in rather than read from `env` here so this module stays pure and the
 * environment is resolved once, by the server component that mounts the provider.
 *
 * @param siteUrl - Absolute origin of the panel, e.g. `https://sisyphus.example.com`.
 */
export const resolveBaseUrl = (siteUrl: string): string =>
  typeof window === 'undefined' ? siteUrl.replace(/\/+$/, '') : window.location.origin

/**
 * The absolute URL of the interactive tRPC surface.
 *
 * The mount path comes from `SISYPHUS_TRPC_ENDPOINT`, exported by the contract package, because the
 * route handler is mounted at the same constant. Sharing it is what stops the two from drifting.
 *
 * @param siteUrl - Absolute origin of the panel.
 */
export const resolveTrpcUrl = (siteUrl: string): string =>
  `${resolveBaseUrl(siteUrl)}${SISYPHUS_TRPC_ENDPOINT}`
