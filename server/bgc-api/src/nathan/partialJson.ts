// Read a JSON object that is still being written ('{"summary": "You have 17 sci-fi ga'), so the words can be shown
// as they arrive. Closes the open string and brackets; if that still doesn't parse, backs off to the last whole value.
export function partialJson(text: string): any {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let s = text.slice(start);
  for (let attempt = 0; attempt < 8 && s.length > 1; attempt++) {
    const closed = close(s);
    try { return JSON.parse(closed); } catch { /* back off */ }
    const cut = lastCut(s);
    if (cut <= 0) break;
    s = s.slice(0, cut);
  }
  return null;
}

// Track strings and brackets, then finish whatever is open
function close(s: string): string {
  const stack: string[] = [];
  let inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += esc ? '\\"' : '"';
  out = out.replace(/[\s,]+$/, '').replace(/:\s*$/, ': null');
  return out + stack.reverse().join('');
}

// Where to cut back to: just before the last comma or opening bracket that is outside a string
function lastCut(s: string): number {
  let inStr = false, esc = false, cut = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === ',') cut = i;
    else if ((ch === '{' || ch === '[') && i > 0) cut = i + 1;
  }
  return cut;
}
