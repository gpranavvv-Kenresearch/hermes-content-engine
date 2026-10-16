/**
 * Minimal RFC-4180 CSV parser (quoted fields, doubled quotes, embedded
 * newlines, CRLF, BOM). Used to read a Sheet export for the legacy audit.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
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
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully empty trailing rows.
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c === '')) rows.pop();
  return rows;
}

/** First row is the header. Duplicate headers keep the first occurrence. */
export function rowsToObjects(rows: string[][]): Array<Record<string, string>> {
  const [header, ...body] = rows;
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return body.map((r) => {
    const obj: Record<string, string> = {};
    names.forEach((name, idx) => {
      if (name !== '' && !(name in obj)) obj[name] = r[idx] ?? '';
    });
    return obj;
  });
}
