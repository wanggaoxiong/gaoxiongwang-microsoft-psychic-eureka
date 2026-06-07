const fs = require('fs');
const path = 'data/wa-messages.json';
const s = fs.readFileSync(path, 'utf8');

const parts = [];
let depth = 0;
let inStr = false;
let esc = false;
let start = -1;
for (let i = 0; i < s.length; i++) {
  const ch = s[i];
  if (inStr) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = false; }
    continue;
  }
  if (ch === '"') { inStr = true; continue; }
  if (ch === '{') {
    if (depth === 0) start = i;
    depth++;
  } else if (ch === '}') {
    depth--;
    if (depth === 0 && start >= 0) {
      parts.push(s.slice(start, i + 1));
      start = -1;
    }
  }
}
console.log('found top-level objects:', parts.length);

const merged = { conversations: {}, messages: [] };
const seen = new Set();
for (let i = 0; i < parts.length; i++) {
  let obj;
  try { obj = JSON.parse(parts[i]); }
  catch (e) { console.warn('part', i, 'parse failed:', e.message); continue; }
  if (!obj || typeof obj !== 'object') continue;
  const convs = obj.conversations || {};
  const msgs = Array.isArray(obj.messages) ? obj.messages : [];
  console.log('part', i, 'convs=', Object.keys(convs).length, 'msgs=', msgs.length);
  for (const m of msgs) {
    if (m && m.id && !seen.has(m.id)) { merged.messages.push(m); seen.add(m.id); }
  }
  for (const [id, c] of Object.entries(convs)) {
    const ex = merged.conversations[id];
    if (!ex) { merged.conversations[id] = c; continue; }
    if ((c.lastTimestamp || 0) > (ex.lastTimestamp || 0)) {
      ex.lastTimestamp = c.lastTimestamp;
      ex.lastMessage = c.lastMessage;
    }
    if (c.pinned) ex.pinned = true;
    if (c.outputLang) ex.outputLang = c.outputLang;
    if (c.name && !ex.name) ex.name = c.name;
    if (typeof c.unread === 'number') ex.unread = Math.max(ex.unread || 0, c.unread);
  }
}

fs.copyFileSync(path, path + '.corrupt-' + Date.now() + '.bak');
fs.writeFileSync(path, JSON.stringify(merged, null, 2));
console.log('merged total msgs=', merged.messages.length, 'convs=', Object.keys(merged.conversations).length);
