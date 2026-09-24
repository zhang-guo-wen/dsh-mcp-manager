/**
 * Typert Remote contribution for the `mcpManager` namespace.
 *
 * Mirror of the artifact `@deepseek-ai/dsh-typert-generator` emits for a Host
 * Remote owner: the browser half mounts it with `ctx.remote.$mount`, which
 * installs a `remote.mcpManager` service exposing add/edit/disable. The
 * codecs are permissive (`parse` passes any value through) because the Host
 * gateway re-derives its own descriptor from the service method signature
 * (`packages/api/gateway` `srcDescriptor`) and validates there; the Client only
 * needs a strict-shaped codec so `$mount` accepts the contribution.
 * @module @guowenzhang/dsh-mcp-manager/remote
 */

import type {
  InvocationDescriptor,
  TypertCodec,
  TypertRemoteContribution,
  TypertSchema,
} from '@deepseek-ai/dsh-typert-protocol'

/** Wire namespace and Cordis service key of the MCP authoring owner. */
export const REMOTE_NAMESPACE = 'mcpManager'

/** Permissive strict codec: accepts any value, returns it unchanged. */
const passthrough: TypertSchema<unknown> = { parse: value => value }

/**
 * One strict codec over {@link passthrough}.
 *
 * Both schema seats carry the same parse contract because the Host's Typert
 * registry changed the strict codec shape: Hosts up to
 * `perf(typert): materialize generated schemas on first use` validate
 * `schema.parse`, later ones require a `create()` factory and call it when a
 * boundary first uses the codec (`validateCodec` rejects a strict codec
 * without it). The published `@deepseek-ai/dsh-typert-protocol` release this
 * package dev-depends on still declares `schema` alone, so the literal cannot
 * satisfy those types while carrying `create`; drop the assertion once a
 * published protocol version declares `create`.
 * @param typeSymbol - generated-style type symbol naming this codec.
 * @returns the strict codec handed to `ctx.remote.$mount`.
 */
function codec(typeSymbol: string): TypertCodec {
  return {
    mode: 'strict' as const,
    typeSymbol,
    schema: passthrough,
    create: () => passthrough,
  } as TypertCodec
}

function descriptor(method: string): InvocationDescriptor {
  const endpoint = `${REMOTE_NAMESPACE}/${method}`
  const owner = `@guowenzhang/dsh-mcp-manager#${endpoint}`
  return {
    id: owner,
    service: REMOTE_NAMESPACE,
    namespace: REMOTE_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: codec(`${owner}:request`),
      },
    ],
    result: codec(`${owner}:result`),
  }
}

/** Contribution mounted by the browser half to reach the MCP authoring owner. */
export const TYPERT_REMOTE: TypertRemoteContribution = {
  package: '@guowenzhang/dsh-mcp-manager',
  descriptors: [
    descriptor('addMcp'),
    descriptor('editMcp'),
    descriptor('disableMcp'),
    descriptor('describeMcp'),
    descriptor('listMcps'),
    descriptor('listMcpTools'),
    descriptor('gateState'),
    descriptor('scanClaudeMcp'),
  ],
}
