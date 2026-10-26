import { chooseStructure, DEFAULT_STRUCTURE, describeStructure, idsInFamily } from '../../src/agents/blogStructures.js';
import type { BlogChatSession, BlogGenResult } from '../../src/agents/blogGenAgent.js';
import { enforceBlogGate, type BlogGateFacts } from './gates.js';
import { formatMeasurements, measureBlog, structuralHardFails } from './measure.js';
import type { BlogEvidence } from './evidence.js';
import type { BlogSupervisor, BlogLimits } from './supervisor.js';
import type { BlogLedger, BlogStateStore } from './state.js';
import type { BlogDecision, BlogGate, BlogRowResult } from './types.js';

export interface BlogRowInput {
  rowIndex: number;
  title: string;
  targetUrl: string;
}

export interface OpenChatParams {
  title: string;
  url: string;
  structure: string;
  /** Corrections from a rejected earlier attempt, appended to the prompt of a fresh chat. */
  promptSuffix?: string;
}

export interface FinishArticleParams {
  blog: BlogGenResult;
  title: string;
  coverImageUrl: string;
  row: BlogRowInput;
}

export interface BlogRowDeps {
  supervisor: BlogSupervisor;
  limits: BlogLimits;
  ledger: BlogLedger;
  store: BlogStateStore;
  evidence: (input: { url: string; title: string }) => Promise<BlogEvidence>;
  openChat: (params: OpenChatParams) => Promise<BlogChatSession>;
  /** Cover image (optional, non-fatal, runs while the article is written). */
  cover?: (input: { title: string; url: string; row: BlogRowInput }) => Promise<{ url: string }>;
  /** Snapshot images, image tags, preferred-source CTA: everything between the approved draft and the Sheet. */
  finishArticle: (params: FinishArticleParams) => Promise<string>;
  save: (row: BlogRowInput, data: { html: string; blog: BlogGenResult; coverImageUrl: string }) => Promise<void>;
  verify: (rowIndex: number) => Promise<{ ok: boolean; reason?: string }>;
  /** v1.3 (default), rotate, random, or one architecture id. */
  structureMode: string;
}

interface ApprovedDraft {
  url: string;
  finalUrl: string;
  title: string;
  structure: string;
  blog: BlogGenResult;
  coverImageUrl: string;
  evidenceText: string;
}

export function buildReviseInstruction(instructions: string): string {
  return [
    'Editorial review found problems in the article you just wrote. Fix ONLY the items below and change nothing else: keep every supported figure, every link, all bolding, the structure and every sentence that is not listed.',
    '',
    instructions.trim(),
    '',
    'Return the COMPLETE deliverable again in exactly the same labelled format as your previous reply (all the labelled sections, then FINAL ARTICLE followed by the full clean HTML). No commentary, no explanation of the changes.',
  ].join('\n');
}

export function buildRestartSuffix(instructions: string): string {
  return `\n\nEDITORIAL REVIEW OF A PREVIOUS ATTEMPT AT THIS SAME ARTICLE (apply these lessons while writing; they do not replace any rule above):\n${instructions.trim()}`;
}

export async function processBlogRow(row: BlogRowInput, deps: BlogRowDeps): Promise<BlogRowResult> {
  const { supervisor, limits, ledger, store } = deps;
  const gates: BlogRowResult['gates'] = [];
  const history: BlogDecision[] = [];
  let structure = DEFAULT_STRUCTURE;

  const result = (status: BlogRowResult['status'], reason: string): BlogRowResult => ({
    rowIndex: row.rowIndex, title: row.title, status, reason, structure, gates,
  });

  const gate = async (name: BlogGate, material: string, facts: Omit<BlogGateFacts, 'gate' | 'revisionsLeft' | 'regenerationsLeft'> ): Promise<BlogDecision> => {
    const asked = await supervisor.decide({ gate: name, material, history, limitsNote: limits.note() });
    const out = enforceBlogGate(asked.decision, { ...facts, gate: name, revisionsLeft: limits.revisionsLeft, regenerationsLeft: limits.regenerationsLeft });
    history.push(out.decision);
    gates.push({ gate: name, action: out.decision.action, reason: out.decision.reason });
    await ledger.append('decision', {
      gate: name, action: out.decision.action, summary: out.decision.reason, overridden: out.overridden,
      instructions: out.decision.instructions, concerns: out.decision.concerns,
    });
    return out.decision;
  };

  // A crash after the draft was approved must not cost another 15-minute generation.
  const saved = await store.loadApprovedDraft<ApprovedDraft>(row.rowIndex);
  let draft: ApprovedDraft | null = saved && saved.url === row.targetUrl ? saved : null;

  if (draft) {
    structure = draft.structure;
    await ledger.append('resume', { summary: `Resuming from the saved approved draft (${draft.structure}).` });
  } else {
    // ---- gate 1: evidence
    const ev = await deps.evidence({ url: row.targetUrl, title: row.title });
    await ledger.append('evidence', { summary: ev.summary.split('\n')[0], pageLoaded: ev.pageLoaded, redirected: ev.redirected, finalUrl: ev.finalUrl });
    // A temporary fetch failure says nothing about the report: surface it as a retryable error instead of recording a skip.
    if (!ev.pageLoaded && ev.transient) throw new Error(`EVIDENCE_FETCH_TRANSIENT: ${ev.summary}`);
    if (!ev.pageLoaded) {
      gates.push({ gate: 'evidence', action: 'stop', reason: ev.summary });
      return result('skipped', ev.summary);
    }
    const evDecision = await gate('evidence', ev.summary, { reportPageLoaded: true, hardFails: [] });
    if (evDecision.action !== 'proceed') return result('skipped', `evidence gate: ${evDecision.reason}`);

    // ---- gate 2: structure
    const mode = deps.structureMode.trim().toLowerCase();
    if (mode === DEFAULT_STRUCTURE) {
      structure = DEFAULT_STRUCTURE;
    } else {
      structure = chooseStructure(mode);
      // An explicit id is a human choice and is not second-guessed; the automatic modes go through the structure gate.
      const forced = !!describeStructure(mode);
      if (!forced) {
        const info = describeStructure(structure);
        const allowed = info ? idsInFamily(info.family) : [];
        const material = [
          ev.summary,
          `\nCANDIDATE ${info?.family === 'format' ? 'FORMAT' : 'ARCHITECTURE'}: ${structure}${info ? ` (${info.label})` : ''}`,
          info?.summary ?? '',
          `\nALLOWED IDS: ${allowed.join(', ')}`,
        ].join('\n');
        const d = await gate('structure', material, { reportPageLoaded: true, hardFails: [] });
        if (d.action === 'stop') return result('skipped', `structure gate: ${d.reason}`);
        if (d.action === 'retry' && d.structure && allowed.includes(d.structure) && limits.structureChangesLeft > 0) {
          limits.structureChanges++;
          structure = d.structure;
          await ledger.append('structure', { summary: `Structure switched to ${structure}` });
        }
      }
    }
    await ledger.append('structure', { summary: `Using ${structure}` });

    // ---- cover image runs while the article is written (separate browser window, best effort)
    let coverImageUrl = '';
    const coverPromise = deps.cover
      ? deps.cover({ title: row.title, url: row.targetUrl, row }).then((r) => { coverImageUrl = r.url; }).catch(async (e: Error) => {
          await ledger.append('cover', { summary: `Cover image failed, continuing without it: ${e.message}` });
        })
      : Promise.resolve();

    // ---- gate 3: draft loop (fix in the same chat, or restart in a fresh chat)
    let suffix = '';
    let session = await deps.openChat({ title: row.title, url: ev.finalUrl, structure });
    let blog: BlogGenResult;
    try {
      blog = await session.generate();
      for (;;) {
        const m = measureBlog({ html: blog.html, seoTitle: blog.seoTitle, metaDescription: blog.description, primaryUrl: ev.finalUrl, evidenceText: ev.evidenceText });
        const hard = structuralHardFails(m);
        await ledger.append('draft', { summary: `${m.words} words, ${m.headings.h2} H2, ${m.links.total} links`, hardFails: hard });
        const material = [
          `EVIDENCE\n${ev.summary}`,
          ev.pageText ? `\nREPORT PAGE TEXT (Ken Research's own data; figures that appear here are supported)\n${ev.pageText}` : '',
          `\nSTRUCTURE IN USE: ${structure}${describeStructure(structure)?.family === 'format' ? `\nFORMAT SPEC (this format's own shape and length band govern; judge the article against it)\n${describeStructure(structure)!.summary}` : ''}`,
          `\nCODE MEASUREMENTS\n${formatMeasurements(m)}`,
          hard.length ? `\nSTRUCTURAL PROBLEMS FOUND BY CODE\n${hard.join('\n')}` : '',
          `\nSEO TITLE: ${blog.seoTitle}\nMETA DESCRIPTION: ${blog.description}`,
          `\nARTICLE HTML\n${blog.html}`,
        ].join('\n');
        const d = await gate('draft', material, { reportPageLoaded: true, hardFails: hard });

        if (d.action === 'proceed') break;
        if (d.action === 'stop') return result('needs_human', `draft gate: ${d.reason}`);
        if (d.action === 'retry') {
          limits.revisions++;
          blog = await session.revise(buildReviseInstruction(d.instructions?.trim() || d.reason));
          continue;
        }
        // regenerate
        limits.regenerations++;
        suffix = buildRestartSuffix(d.instructions?.trim() || d.reason);
        await session.close();
        session = await deps.openChat({ title: row.title, url: ev.finalUrl, structure, promptSuffix: suffix });
        blog = await session.generate();
      }
    } finally {
      await session.close().catch(() => {});
    }
    await coverPromise;

    draft = { url: row.targetUrl, finalUrl: ev.finalUrl, title: row.title, structure, blog, coverImageUrl, evidenceText: ev.evidenceText };
    await store.saveApprovedDraft(row.rowIndex, draft);
  }

  // ---- images, image tags and the preferred-source call to action
  const html = await deps.finishArticle({ blog: draft.blog, title: draft.title, coverImageUrl: draft.coverImageUrl, row });

  // ---- gate 4: final (proceed or stop only)
  const fm = measureBlog({ html, seoTitle: draft.blog.seoTitle, metaDescription: draft.blog.description, primaryUrl: draft.finalUrl, evidenceText: draft.evidenceText });
  const fhard = [...structuralHardFails(fm), ...(fm.imagePlaceholders > 0 ? [`${fm.imagePlaceholders} unresolved image placeholder(s)`] : [])];
  const fd = await gate('final', [`CODE MEASUREMENTS (assembled article)\n${formatMeasurements(fm)}`, fhard.length ? `\nSTRUCTURAL PROBLEMS FOUND BY CODE\n${fhard.join('\n')}` : '', `\nARTICLE HTML\n${html}`].join('\n'), { reportPageLoaded: true, hardFails: fhard });
  if (fd.action !== 'proceed') return result('needs_human', `final gate: ${fd.reason}`);

  // ---- save and read back
  for (let attempt = 1; attempt <= 2; attempt++) {
    await deps.save(row, { html, blog: draft.blog, coverImageUrl: draft.coverImageUrl });
    const v = await deps.verify(row.rowIndex);
    if (v.ok) {
      await store.clearApprovedDraft(row.rowIndex);
      await ledger.append('result', { summary: `Row ${row.rowIndex} written and verified${v.reason ? ` (${v.reason})` : ''}` });
      return result('written', v.reason ?? 'verified');
    }
    await ledger.append('result', { summary: `Verification failed (attempt ${attempt}): ${v.reason}` });
  }
  return result('needs_human', 'Sheet write could not be verified; the approved article is kept for the next attempt');
}
