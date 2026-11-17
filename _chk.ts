import { getSheetRowByIndex } from './browser-generation/src/sheets/sheets.js';
for (const r of [14, 52, 53]) {
  const x: any = await getSheetRowByIndex(r, 'newLogic');
  console.log(r, 'blogContent chars:', (x?.blogContent || '').length, '| keys:', x ? Object.keys(x).slice(0, 14).join(',') : null);
}
