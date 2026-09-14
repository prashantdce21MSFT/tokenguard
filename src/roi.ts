import * as vscode from 'vscode';
import { buildRequestModelMap } from './transcripts';
import { getCalibration } from './history';

/**
 * Model-ROI / "did the edit stick?" analysis.
 *
 * Reads VS Code's chatEditingSessions checkpoints for THIS workspace (found via
 * the extension's own storage hash) and joins them with git to tell whether the
 * files AI changed actually survived — or were reverted / repeatedly re-edited.
 *
 * This is the signal neither a session viewer nor a search tool can give: not
 * "what did AI change" but "was the change worth keeping".
 */

export type Verdict = 'kept' | 'rework' | 'discarded' | 'pending';

export interface FileRoi {
    fsPath: string;
    relPath: string;
    editOps: number;
    /** Distinct AI requests that touched this file — a proxy for iterations. */
    iterations: number;
    created: boolean;
    existsNow: boolean;
    verdict: Verdict;
    /** Models that produced edits to this file (via requestId join). */
    models: string[];
}

export interface ModelRoi {
    model: string;
    filesTouched: number;
    iterations: number;
    kept: number;
    rework: number;
    discarded: number;
    pending: number;
    /** Estimated spend = per-model avg cost/turn (from calibration) × iterations. */
    estCostUsd: number | undefined;
}

export interface RoiResult {
    generatedAt: string;
    workspaceRoot: string | undefined;
    gitAvailable: boolean;
    sessionsScanned: number;
    /** True when at least one edit could be attributed to a model. */
    attributed: boolean;
    files: FileRoi[];
    perModel: ModelRoi[];
    kept: number;
    rework: number;
    discarded: number;
    pending: number;
}

interface RawOp {
    type: string;
    fsPath: string;
    requestId: string;
}

function opsFromState(json: unknown): RawOp[] {
    const out: RawOp[] = [];
    const timeline = (json as { timeline?: { operations?: unknown[] } })?.timeline;
    const operations = Array.isArray(timeline?.operations) ? timeline!.operations! : [];
    for (const raw of operations) {
        const o = raw as { type?: unknown; uri?: { fsPath?: unknown }; requestId?: unknown };
        const fsPath = typeof o?.uri?.fsPath === 'string' ? o.uri.fsPath : undefined;
        if (!fsPath) {
            continue;
        }
        out.push({
            type: typeof o.type === 'string' ? o.type : 'edit',
            fsPath,
            requestId: typeof o.requestId === 'string' ? o.requestId : ''
        });
    }
    return out;
}

async function readSessions(editingRoot: vscode.Uri): Promise<{ ops: RawOp[]; sessions: number }> {
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(editingRoot);
    } catch {
        return { ops: [], sessions: 0 };
    }
    const ops: RawOp[] = [];
    let sessions = 0;
    for (const [name, type] of entries) {
        if (type !== vscode.FileType.Directory) {
            continue;
        }
        const stateUri = vscode.Uri.joinPath(editingRoot, name, 'state.json');
        try {
            const bytes = await vscode.workspace.fs.readFile(stateUri);
            const json = JSON.parse(new TextDecoder('utf-8').decode(bytes));
            const sessionOps = opsFromState(json);
            if (sessionOps.length > 0) {
                sessions++;
                ops.push(...sessionOps);
            }
        } catch {
            // skip unreadable/empty session
        }
    }
    return { ops, sessions };
}

function norm(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
}

/** Analyse edit ROI for the current workspace. */
export async function loadEditRoi(
    storageUri: vscode.Uri | undefined,
    workspaceRoot: vscode.Uri | undefined
): Promise<RoiResult> {
    const empty: RoiResult = {
        generatedAt: new Date().toISOString(),
        workspaceRoot: workspaceRoot?.fsPath,
        gitAvailable: false,
        sessionsScanned: 0,
        attributed: false,
        files: [],
        perModel: [],
        kept: 0,
        rework: 0,
        discarded: 0,
        pending: 0
    };
    if (!storageUri || !workspaceRoot) {
        return empty;
    }

    // storageUri = .../workspaceStorage/<hash>/<publisher.ext>; parent = <hash>.
    const editingRoot = vscode.Uri.joinPath(storageUri, '..', 'chatEditingSessions');
    const { ops, sessions } = await readSessions(editingRoot);
    const modelMap = await buildRequestModelMap(storageUri);

    const rootNorm = norm(workspaceRoot.fsPath).replace(/\/$/, '') + '/';
    const byFile = new Map<string, { ops: number; requests: Set<string>; created: boolean; models: Set<string> }>();
    for (const op of ops) {
        if (!norm(op.fsPath).startsWith(rootNorm)) {
            continue; // only files inside this workspace
        }
        const agg = byFile.get(op.fsPath) ?? { ops: 0, requests: new Set<string>(), created: false, models: new Set<string>() };
        agg.ops++;
        if (op.requestId) {
            agg.requests.add(op.requestId);
            const m = modelMap.get(op.requestId);
            if (m) {
                agg.models.add(m);
            }
        }
        if (op.type === 'create') {
            agg.created = true;
        }
        byFile.set(op.fsPath, agg);
    }

    const files: FileRoi[] = [];
    for (const [fsPath, agg] of byFile) {
        const uri = vscode.Uri.file(fsPath);
        let existsNow = true;
        try {
            await vscode.workspace.fs.stat(uri);
        } catch {
            existsNow = false;
        }
        const rel = norm(fsPath).slice(rootNorm.length);
        const iterations = Math.max(agg.requests.size, 1);

        let verdict: Verdict;
        if (!existsNow && agg.created) {
            verdict = 'discarded'; // AI created it, it's gone now
        } else if (iterations >= 3) {
            verdict = 'rework'; // many AI passes on the same file
        } else if (existsNow) {
            verdict = 'kept'; // file survived on disk
        } else {
            verdict = 'pending';
        }

        files.push({
            fsPath,
            relPath: rel,
            editOps: agg.ops,
            iterations,
            created: agg.created,
            existsNow,
            verdict,
            models: [...agg.models].sort()
        });
    }

    files.sort((a, b) => b.iterations - a.iterations || b.editOps - a.editOps);

    // Per-model rollup, with cost estimated from calibration avg cost/turn.
    const cal = getCalibration();
    const modelAgg = new Map<string, ModelRoi>();
    for (const f of files) {
        for (const model of f.models) {
            const m = modelAgg.get(model) ?? {
                model, filesTouched: 0, iterations: 0, kept: 0, rework: 0, discarded: 0, pending: 0, estCostUsd: undefined
            };
            m.filesTouched++;
            m.iterations += f.iterations;
            m[f.verdict]++;
            modelAgg.set(model, m);
        }
    }
    const perModel = [...modelAgg.values()];
    for (const m of perModel) {
        let avg: number | undefined;
        if (cal) {
            for (const s of Object.values(cal.perModel)) {
                if (m.model.toLowerCase().includes(s.model.toLowerCase()) || s.model.toLowerCase().includes(m.model.toLowerCase())) {
                    avg = s.avgCostUsd;
                    break;
                }
            }
        }
        m.estCostUsd = avg !== undefined ? avg * m.iterations : undefined;
    }
    perModel.sort((a, b) => (b.estCostUsd ?? 0) - (a.estCostUsd ?? 0) || b.iterations - a.iterations);

    return {
        generatedAt: new Date().toISOString(),
        workspaceRoot: workspaceRoot.fsPath,
        gitAvailable: false,
        sessionsScanned: sessions,
        attributed: perModel.length > 0,
        files,
        perModel,
        kept: files.filter(f => f.verdict === 'kept').length,
        rework: files.filter(f => f.verdict === 'rework').length,
        discarded: files.filter(f => f.verdict === 'discarded').length,
        pending: files.filter(f => f.verdict === 'pending').length
    };
}

const VERDICT_ICON: Record<Verdict, string> = {
    kept: '✅',
    rework: '🔁',
    discarded: '🗑️',
    pending: '🕗'
};

/** Human-readable Markdown report of edit ROI. */
export function formatRoiReport(r: RoiResult): string {
    const lines: string[] = [];
    lines.push('# TokenGuard — Edit ROI (did the AI edits stick?)');
    lines.push('');
    if (!r.workspaceRoot) {
        lines.push('Open a folder to analyse edit ROI.');
        return lines.join('\n');
    }
    lines.push(`_Scanned ${r.sessionsScanned} editing session(s) for ${r.files.length} file(s) in this workspace._`);
    if (!r.gitAvailable) {
        lines.push('');
        lines.push('> Git not detected here, so kept/discarded verdicts are limited. Iteration counts are still exact.');
    }
    lines.push('');
    lines.push(`- ✅ Kept: **${r.kept}**   🔁 Rework: **${r.rework}**   🗑️ Discarded: **${r.discarded}**   🕗 Pending: **${r.pending}**`);
    lines.push('');
    if (r.files.length === 0) {
        lines.push('No AI edits recorded for this workspace yet.');
        return lines.join('\n');
    }
    lines.push('| File | Model(s) | Iterations | Edits | Verdict |');
    lines.push('|---|---|---:|---:|---|');
    for (const f of r.files.slice(0, 50)) {
        const models = f.models.length ? f.models.join(', ') : '—';
        lines.push(`| ${f.relPath} | ${models} | ${f.iterations} | ${f.editOps} | ${VERDICT_ICON[f.verdict]} ${f.verdict} |`);
    }
    lines.push('');

    if (r.perModel.length > 0) {
        lines.push('## Model ROI');
        lines.push('');
        lines.push('| Model | Files | Iterations | ✅ Kept | 🔁 Rework | 🗑️ Discarded | Est. spend |');
        lines.push('|---|---:|---:|---:|---:|---:|---:|');
        for (const m of r.perModel) {
            const cost = m.estCostUsd !== undefined ? `$${m.estCostUsd.toFixed(2)}` : '—';
            lines.push(`| ${m.model} | ${m.filesTouched} | ${m.iterations} | ${m.kept} | ${m.rework} | ${m.discarded} | ${cost} |`);
        }
        lines.push('');
        lines.push('_Est. spend = your per-model average cost/turn (from Personal Calibration) × iterations — an estimate, not a billed figure. Run **TokenGuard: Show Personal Calibration** first for accurate per-model costs._');
    } else {
        lines.push('> No model attribution available — these edits predate the transcript format that records `modelId`, or transcripts aren\'t present. Iteration/verdict counts are still exact.');
    }
    lines.push('');
    lines.push('**How to read this:** 🔁 rework = the AI needed 3+ separate passes on the same file — those are your most expensive, lowest-ROI edits and the best candidates for a stronger model or a clearer prompt. 🗑️ discarded = AI-created files that no longer exist (spend that produced nothing kept). If a premium model dominates 🔁/🗑️, that\'s your evidence it isn\'t paying off for those tasks.');
    return lines.join('\n');
}
