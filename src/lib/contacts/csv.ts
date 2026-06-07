/**
 * 极简 CSV 解析（支持双引号包裹的字段、转义双引号 ""）。
 * 第一行视作表头；返回每行为 { header -> value } 的对象。
 * 不依赖第三方库，足够覆盖手机通讯录 / Excel 导出的常见 CSV。
 */

export function parseCsv(input: string): Record<string, string>[] {
  if (!input || !input.trim()) return [];
  const rows = splitRows(input);
  if (rows.length === 0) return [];
  const headers = rows[0]!.map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.every((c) => !c)) continue;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (row[idx] ?? '').trim();
    });
    out.push(obj);
  }
  return out;
}

function splitRows(input: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      cur.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = '';
      continue;
    }
    field += ch;
  }
  cur.push(field);
  if (cur.length > 1 || cur[0] !== '') rows.push(cur);
  return rows;
}

/**
 * 根据列名启发式映射到 Contact 字段。
 * 兼容：name / 姓名 / 名字 / Name；phone / 手机 / 电话 / Phone；tags / 标签 / 分组 等。
 */
export function mapCsvRow(row: Record<string, string>): {
  phone?: string;
  lid?: string;
  name?: string;
  company?: string;
  position?: string;
  note?: string;
  tags?: string[];
} {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      for (const actual of Object.keys(row)) {
        if (actual.toLowerCase() === k.toLowerCase() && row[actual]) {
          return row[actual];
        }
      }
    }
    return undefined;
  };
  const tagsRaw = pick('tags', 'tag', '标签', '分组', 'group');
  return {
    phone: pick('phone', 'mobile', 'tel', '手机', '电话', '手机号', '号码', 'whatsapp'),
    lid: pick('lid'),
    name: pick('name', '姓名', '名字', '昵称', 'displayname', 'display name'),
    company: pick('company', '公司', 'organization', 'org'),
    position: pick('position', 'title', '职位', '岗位'),
    note: pick('note', 'notes', '备注', 'remark'),
    tags: tagsRaw
      ? tagsRaw
          .split(/[,;，；|]/)
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined
  };
}
