import { pickNextRow, writeGeneratedPost, type SheetsApi } from '../../../src/sheets/social-sheet.js';
import { choosePrimaryKeyword } from '../../../src/social/runner.js';
import type { AgentReport, SocialPlatform } from '../types.js';

export interface SheetPickOutput {
  rowIndex: number;
  url: string;
  title: string;
  keyword: string;
}

const KEYWORD_COLUMNS = ['primary keyword', 'seo keyword', 'seokeywords', 'keyword', 'keywords'];

export function titleFromSheet(title: string): string {
  return title.replace(/\b(?:Market Share|Market Size|Companies|Trends|Forecast|Outlook|Analysis|Report)\b.*$/i, '').replace(/\s+/g, ' ').trim() || title.trim();
}

function keywordFromRow(rows: string[][], rowIndex: number): string | undefined {
  const headers = rows[0]?.map((s) => s.trim().toLowerCase()) ?? [];
  const index = KEYWORD_COLUMNS.map((name) => headers.indexOf(name)).find((i) => i >= 0);
  if (index === undefined) return undefined;
  return rows[rowIndex - 1]?.[index]?.split(/[;,]/)[0]?.trim() || undefined;
}

/** Same row rules as the live posting daemon (see src/sheets/social-sheet.ts). null when nothing is left. */
export function pickRowAgent(rows: string[][], platform: SocialPlatform, exclude: ReadonlySet<number>, keywordOverride?: string): AgentReport<SheetPickOutput> | null {
  const pick = pickNextRow(rows, platform, undefined, { skipGenerated: true, exclude });
  if (!pick) return null;
  const title = titleFromSheet(pick.title);
  const keyword = choosePrimaryKeyword(title, keywordOverride ?? keywordFromRow(rows, pick.rowIndex));
  return {
    agent: 'sheet',
    output: { rowIndex: pick.rowIndex, url: pick.url, title, keyword },
    summary: `Picked row ${pick.rowIndex} for ${platform}: "${title}" with keyword "${keyword}".`,
    concerns: [],
  };
}

/** A fixed row (--row): same keyword and title rules, no scanning. null when the row is missing or has no URL. */
export function pickFixedRowAgent(rows: string[][], platform: SocialPlatform, row: number, keywordOverride?: string): AgentReport<SheetPickOutput> | null {
  const pick = pickNextRow(rows, platform, row);
  if (!pick) return null;
  const title = titleFromSheet(pick.title);
  const keyword = choosePrimaryKeyword(title, keywordOverride ?? keywordFromRow(rows, pick.rowIndex));
  return {
    agent: 'sheet',
    output: { rowIndex: pick.rowIndex, url: pick.url, title, keyword },
    summary: `Using row ${pick.rowIndex} for ${platform}: "${title}" with keyword "${keyword}".`,
    concerns: [],
  };
}

export async function writeRowAgent(api: SheetsApi, platform: SocialPlatform, pick: SheetPickOutput, text: string): Promise<AgentReport<{ cell: string; verified: boolean }>> {
  const done = await writeGeneratedPost(api, platform, { rowIndex: pick.rowIndex, url: pick.url }, text);
  return {
    agent: 'sheet',
    output: { cell: done.cell, verified: done.verified },
    summary: `Wrote the post to ${done.cell}; read-back ${done.verified ? 'matched' : 'DID NOT match'}.`,
    concerns: done.verified ? [] : ['read-back mismatch'],
  };
}
