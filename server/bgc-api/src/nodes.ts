// Running one of n8n's code nodes (nodes.gen.ts) the way n8n does: $input is what flows in, and $('Name') is an
// earlier node's output. Returns the node's first output, or null when it outputs nothing (n8n's "no items").
import { NODES } from './nodes.gen.js';

export function runNode(workflow: string, name: string, input: unknown, seen: Record<string, unknown> = {}): any {
  const item = (json: unknown) => ({ json });
  const $ = (n: string) => ({ first: () => item(seen[n]), all: () => [item(seen[n])] });
  const out = NODES[workflow][name]($, { first: () => item(input), all: () => [item(input)] });
  return out?.[0]?.json ?? null;
}
