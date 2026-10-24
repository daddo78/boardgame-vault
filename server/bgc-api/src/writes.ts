// Checking a change's input as n8n does: the workflow's own Validate node (validate.gen.ts) runs on the same body and
// sign-in, so both accept and reject the same things. A rejection is { ok: false, status, message }, passed on as is.
import { fromDb } from './errors.js';
import { body, type Ctx } from './request.js';
import { VALIDATE } from './validate.gen.js';

// The changes whose Validate node runs here. validate.gen.ts is generated and types its names only as strings, so this
// list is what makes a typo a compile error; at start, a name without a node is caught here instead of on first use.
export const WORKFLOWS = ['meSave', 'memoryForget', 'wishChange', 'ruleChange', 'rate', 'update', 'del', 'playerSave'] as const;
export type Workflow = (typeof WORKFLOWS)[number];
for (const w of WORKFLOWS) if (typeof VALIDATE[w] !== 'function') throw new Error(`validate.gen.ts has no Validate node for ${w}`);

export async function validated(workflow: Workflow, c: Ctx): Promise<Record<string, any>> {
  const json = { body: await body(c), _auth: c.get('auth') };
  const [out] = VALIDATE[workflow]({ first: () => ({ json }) });
  return fromDb(out?.json ?? null);
}
