import { z } from 'zod';
import { browserActionSchema, browserManualActionSchema, browserNavigationActionSchema } from '../../../packages/contracts/src/assistant-browser.js';

/** VM stdio is a private, finite protocol, never a shell or JavaScript evaluation API. */
export const browserRpcLimit = 4 * 1024 * 1024;
export const browserSessionLimit = 2 * 1024 * 1024;
const id = z.number().int().min(1).max(2147483647);
const base = { v: z.literal(1), id };
const state = z.unknown().refine(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try { return Buffer.byteLength(JSON.stringify(value)) <= browserSessionLimit; } catch { return false; }
});
export const browserRpcRequest = z.discriminatedUnion('op', [
  z.object({ ...base, op: z.literal('open'), state: state.nullable() }).strict(),
  z.object({ ...base, op: z.literal('observe') }).strict(),
  z.object({ ...base, op: z.literal('frame') }).strict(),
  z.object({ ...base, op: z.literal('state') }).strict(),
  z.object({ ...base, op: z.literal('diagnostics') }).strict(),
  z.object({ ...base, op: z.literal('execute'), action: browserActionSchema.refine(action => !['done','handoff'].includes(action.kind)) }).strict(),
  z.object({ ...base, op: z.literal('manual'), action: browserManualActionSchema, expectedRevision: z.uuid().optional() }).strict(),
  z.object({ ...base, op: z.literal('navigate'), action: browserNavigationActionSchema }).strict(),
  z.object({ ...base, op: z.literal('close') }).strict(),
  z.object({ ...base, op: z.literal('cancel') }).strict(),
  z.object({ ...base, op: z.literal('grant'), nonce: z.uuid(), allow: z.boolean() }).strict(),
]);
export type BrowserRpcRequest = z.infer<typeof browserRpcRequest>;
export const browserRpcErrors = ['HANDOFF','UNAVAILABLE','CANCELED','PROTOCOL','BROWSER_SANDBOX_UNAVAILABLE','BROWSER_EXECUTABLE_MISSING','BROWSER_DEPENDENCIES_MISSING','BROWSER_RUNTIME_UNAVAILABLE','BROWSER_TEMPLATE_UNAVAILABLE'] as const;
export type BrowserRpcError = typeof browserRpcErrors[number];
export const browserRpcReply = z.discriminatedUnion('kind', [
  z.object({ ...base, kind:z.literal('result'), value:z.unknown() }).strict(),
  z.object({ ...base, kind:z.literal('error'), code:z.enum(browserRpcErrors) }).strict(),
  z.object({ ...base, kind:z.literal('guard'), nonce:z.uuid() }).strict(),
]);
export type BrowserRpcReply = z.infer<typeof browserRpcReply>;
const base64 = z.string().max(1400000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const browserRpcFrame = z.object({
  jpeg:base64, width:z.number().int().min(1).max(4096), height:z.number().int().min(1).max(4096),
  url:z.string().max(8192), title:z.string().max(200),
  canGoBack:z.boolean().optional(), canGoForward:z.boolean().optional(),
  revision:z.uuid().optional(),
}).strict();
export const browserRpcObservation = z.object({
  snapshotId:z.uuid(),url:z.string().max(8192),title:z.string().max(200),text:z.string().max(12000),
  controls:z.array(z.object({ref:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),role:z.string().max(100),name:z.string().max(160),disabled:z.boolean(),type:z.string().max(100).optional()}).strict()).max(100),
  image:base64.optional(),sensitive:z.boolean().optional(),
}).strict();
export const browserRpcDiagnostics=z.object({uid:z.number().int().min(-1).max(2147483647),kernel:z.string().regex(/^(?:\d+\.\d+\.\d+|unknown)$/),prohibitedFlags:z.boolean(),processes:z.array(z.object({role:z.enum(['browser','renderer','zygote','gpu-process','utility','other']),seccomp:z.union([z.literal(0),z.literal(1),z.literal(2),z.null()]),noNewPrivileges:z.union([z.literal(0),z.literal(1),z.null()]),userNamespaceDifferent:z.boolean().nullable(),pidNamespaceDifferent:z.boolean().nullable(),netNamespaceDifferent:z.boolean().nullable(),count:z.number().int().min(1).max(2000)}).strict()).max(32)}).strict();

export function browserRpcResult(op: BrowserRpcRequest['op'], input: unknown) {
  if (op === 'observe') return browserRpcObservation.parse(input);
  if (op === 'frame') return browserRpcFrame.parse(input);
  if (op === 'state') return state.parse(input);
  if (op === 'diagnostics') return browserRpcDiagnostics.parse(input);
  if (input !== null) throw Error('BROWSER_RPC_INVALID');
  return null;
}

export function encodeBrowserRpc(value: BrowserRpcRequest | BrowserRpcReply) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > browserRpcLimit) throw Error('BROWSER_RPC_LIMIT');
  return line + '\n';
}

/** Limit incomplete frames too: no attacker-controlled unbounded stdout accumulation. */
export class BrowserRpcLines {
  private buffered = '';
  constructor(private readonly receive: (value: unknown) => void) {}
  push(chunk: string) {
    if (Buffer.byteLength(chunk) > browserRpcLimit) throw Error('BROWSER_RPC_LIMIT');
    this.buffered += chunk;
    while (this.buffered.includes('\n')) {
      const at = this.buffered.indexOf('\n'), line = this.buffered.slice(0, at);
      this.buffered = this.buffered.slice(at + 1);
      if (!line || Buffer.byteLength(line) > browserRpcLimit) throw Error('BROWSER_RPC_INVALID');
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw Error('BROWSER_RPC_INVALID'); }
      this.receive(value);
    }
    if (Buffer.byteLength(this.buffered) > browserRpcLimit) throw Error('BROWSER_RPC_LIMIT');
  }
}
