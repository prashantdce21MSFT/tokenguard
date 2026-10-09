import * as vscode from 'vscode';
import { costUsdWithCache, costSplitWithCache, costUsdRealCache, costSplitRealCache, priceForModel } from './pricing';
import { loadAgentSessions } from './agentsessions';

/**
 * Reads REAL per-turn token counts that VS Code Copilot persists to disk in
 * chatSessions/*.jsonl — `promptTokens` / `outputTokens` inside each request's
 * result.metadata — the same ground-truth fields AgentsView reads. This is not
 * an estimate: it's what Copilot actually recorded for each turn.
 */

export interface ModelUsage {
    model: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

export interface ProjectUsage {
    project: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
}

export interface DailyUsage {
    date: string;            // YYYY-MM-DD (local)
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    byModel: Record<string, number>; // model -> costUsd
}

/** Granular bucket for interactive filtering (date × model × project). */
export interface UsageCell {
    date: string;
    model: string;
    project: string;
    input: number;
    output: number;
    cost: number;
    inputCost: number;
    outputCost: number;
    turns: number;
}

export interface SessionTurn {
    date: string;
    model: string;
    input: number;
    output: number;
    cost: number;
    snippet: string;
    file: string;
}

export interface SessionUsage {
    sessionId: string;
    project: string;
    title: string;
    date: string;
    turns: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    /** The single most expensive turn in this session. */
    peakInput: number;
    peakModel: string;
    peakSnippet: string;
    peakFile: string;
    /** Turn-by-turn detail (capped) for the history drill-down. */
    detail: SessionTurn[];
}

export interface RealUsage {
    generatedAt: string;
    scope: 'workspace' | 'all';
    sessionsScanned: number;
    totalTurns: number;
    totalInput: number;
    totalOutput: number;
    totalCostUsd: number;
    perModel: ModelUsage[];
    perProject: ProjectUsage[];
    daily: DailyUsage[];
    activeDays: number;
    peakDay: { date: string; costUsd: number } | undefined;
    /** Granular cells for interactive filtering. */
    cells: UsageCell[];
    /** Per-session breakdown (top sessions by input tokens). */
    sessions: SessionUsage[];
    /** Resolved per-1M USD rates for each model seen, for client-side what-if math. */
    prices: Record<string, { input: number; output: number }>;
}

interface Turn {
    model: string;
    input: number;
    output: number;
    responseId: string;
    ts: number;
    snippet: string;
    files: string[];
    /** Real prompt-cache read count (agent-mode sessions only); undefined for legacy jsonl. */
    cacheRead?: number;
}

function normalizeModel(modelId: string): string {
    const slash = modelId.lastIndexOf('/');
    return (slash >= 0 ? modelId.slice(slash + 1) : modelId).trim();
}

function num(v: unknown): number {
    return typeof v === 'number' && isFinite(v) ? v : 0;
}

/** Extract token-bearing turns from one parsed JSONL entry (any kind). */
function turnsFromEntry(entry: unknown, out: Turn[]): void {
    const requests = (entry as { v?: { requests?: unknown[] } })?.v?.requests;
    if (!Array.isArray(requests)) {
        return;
    }
    for (const raw of requests) {
        const req = raw as {
            modelId?: unknown;
            timestamp?: unknown;
            message?: unknown;
            variableData?: { variables?: unknown };
            result?: { metadata?: Record<string, unknown> };
        };
        const meta = req?.result?.metadata;
        if (!meta || (meta.promptTokens === undefined && meta.outputTokens === undefined)) {
            continue;
        }
        const modelSource =
            typeof req.modelId === 'string' ? req.modelId :
            typeof meta.resolvedModel === 'string' ? meta.resolvedModel : 'unknown';
        const msg = req.message as { text?: unknown } | string | undefined;
        const snippet = typeof msg === 'string' ? msg : (typeof msg?.text === 'string' ? msg.text : '');
        const vars = Array.isArray(req.variableData?.variables) ? req.variableData!.variables as Array<{ name?: unknown }> : [];
        const files = vars.map(v => (typeof v?.name === 'string' ? v.name : '')).filter(Boolean).slice(0, 6);
        out.push({
            model: normalizeModel(modelSource),
            input: num(meta.promptTokens),
            output: num(meta.outputTokens),
            responseId: typeof meta.responseId === 'string' ? meta.responseId : '',
            ts: num(req.timestamp),
            snippet: snippet.slice(0, 140),
            files
        });
    }
}

/** Derive a human project name for a workspace-storage hash folder. */
async function projectForHash(hashDir: vscode.Uri): Promise<string> {
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(hashDir, 'workspace.json'));
        const json = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as { folder?: string; workspace?: string };
        const uri = json.folder ?? json.workspace;
        if (uri) {
            const decoded = decodeURIComponent(uri);
            const seg = decoded.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
            if (seg) {
                return seg;
            }
        }
    } catch {
        // no workspace.json (empty-window sessions) or unreadable
    }
    return 'unknown';
}

async function chatSessionDirs(
    storageUri: vscode.Uri,
    scope: 'workspace' | 'all'
): Promise<Array<{ dir: vscode.Uri; project: string }>> {
    // storageUri = .../workspaceStorage/<hash>/<publisher.ext>
    const hashDir = vscode.Uri.joinPath(storageUri, '..');
    if (scope === 'workspace') {
        return [{ dir: vscode.Uri.joinPath(hashDir, 'chatSessions'), project: await projectForHash(hashDir) }];
    }
    const storageRoot = vscode.Uri.joinPath(hashDir, '..');
    const dirs: Array<{ dir: vscode.Uri; project: string }> = [];
    try {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(storageRoot)) {
            if (type === vscode.FileType.Directory) {
                const hd = vscode.Uri.joinPath(storageRoot, name);
                dirs.push({ dir: vscode.Uri.joinPath(hd, 'chatSessions'), project: await projectForHash(hd) });
            }
        }
    } catch {
        dirs.push({ dir: vscode.Uri.joinPath(hashDir, 'chatSessions'), project: await projectForHash(hashDir) });
    }
    return dirs;
}

/** Load real token usage from Copilot's persisted transcripts. */
export async function loadRealUsage(
    storageUri: vscode.Uri | undefined,
    scope: 'workspace' | 'all' = 'workspace'
): Promise<RealUsage> {
    const base: RealUsage = {
        generatedAt: new Date().toISOString(),
        scope,
        sessionsScanned: 0,
        totalTurns: 0,
        totalInput: 0,
        totalOutput: 0,
        totalCostUsd: 0,
        perModel: [],
        perProject: [],
        daily: [],
        activeDays: 0,
        peakDay: undefined,
        cells: [],
        sessions: [],
        prices: {}
    };
    const dirs = storageUri ? await chatSessionDirs(storageUri, scope) : [];
    const seen = new Set<string>();
    const byModel = new Map<string, ModelUsage>();
    const byProject = new Map<string, ProjectUsage>();
    const byDay = new Map<string, DailyUsage>();
    const byCell = new Map<string, UsageCell>();
    const sessionList: SessionUsage[] = [];
    let sessions = 0;

    // Fold a single turn into every aggregation map plus its session accumulator.
    // Shared by the legacy chatSessions/*.jsonl path and the agent-mode SQLite path.
    const accumulate = (turn: Turn, project: string, sess: SessionUsage): void => {
        // Dedup by responseId so snapshot + patch entries aren't double-counted.
        const key = turn.responseId || `${sess.sessionId}:${seen.size}`;
        if (turn.responseId && seen.has(key)) {
            return;
        }
        seen.add(key);
        const m = byModel.get(turn.model) ?? {
            model: turn.model, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0
        };
        m.turns++;
        m.inputTokens += turn.input;
        m.outputTokens += turn.output;
        const turnCost = turn.cacheRead != null
            ? costUsdRealCache(turn.model, turn.input, turn.cacheRead, turn.output)
            : costUsdWithCache(turn.model, turn.input, turn.output);
        m.costUsd += turnCost;
        byModel.set(turn.model, m);

        const p = byProject.get(project) ?? {
            project, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0
        };
        p.turns++;
        p.inputTokens += turn.input;
        p.outputTokens += turn.output;
        p.costUsd += turnCost;
        byProject.set(project, p);

        const date = turn.ts > 0
            ? (() => { const d = new Date(turn.ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })()
            : 'undated';

        sess.turns++;
        sess.inputTokens += turn.input;
        sess.outputTokens += turn.output;
        sess.costUsd += turnCost;
        if (date !== 'undated' && !sess.date) {
            sess.date = date;
        }
        if (turn.input > sess.peakInput) {
            sess.peakInput = turn.input;
            sess.peakModel = turn.model;
            sess.peakSnippet = turn.snippet;
            sess.peakFile = turn.files[0] ?? '';
        }
        if (sess.detail.length < 200) {
            sess.detail.push({
                date,
                model: turn.model,
                input: turn.input,
                output: turn.output,
                cost: turnCost,
                snippet: turn.snippet,
                file: turn.files[0] ?? ''
            });
        }

        const cellKey = `${date}|${turn.model}|${project}`;
        const cell = byCell.get(cellKey) ?? { date, model: turn.model, project, input: 0, output: 0, cost: 0, inputCost: 0, outputCost: 0, turns: 0 };
        const split = turn.cacheRead != null
            ? costSplitRealCache(turn.model, turn.input, turn.cacheRead, turn.output)
            : costSplitWithCache(turn.model, turn.input, turn.output);
        cell.input += turn.input;
        cell.output += turn.output;
        cell.cost += turnCost;
        cell.inputCost += split.input;
        cell.outputCost += split.output;
        cell.turns++;
        byCell.set(cellKey, cell);

        if (turn.ts > 0) {
            const d = new Date(turn.ts);
            const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const day = byDay.get(dateKey) ?? { date: dateKey, inputTokens: 0, outputTokens: 0, costUsd: 0, byModel: {} };
            day.inputTokens += turn.input;
            day.outputTokens += turn.output;
            day.costUsd += turnCost;
            day.byModel[turn.model] = (day.byModel[turn.model] ?? 0) + turnCost;
            byDay.set(dateKey, day);
        }
    };

    for (const { dir, project } of dirs) {
        let files: [string, vscode.FileType][];
        try {
            files = await vscode.workspace.fs.readDirectory(dir);
        } catch {
            continue;
        }
        for (const [name, type] of files) {
            if (type !== vscode.FileType.File || !name.endsWith('.jsonl')) {
                continue;
            }
            let text: string;
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
                text = new TextDecoder('utf-8').decode(bytes);
            } catch {
                continue;
            }
            const turns: Turn[] = [];
            let title = '';
            for (const line of text.split('\n')) {
                const t = line.trim();
                if (!t) {
                    continue;
                }
                try {
                    const entry = JSON.parse(t);
                    const ct = (entry as { v?: { customTitle?: unknown } })?.v?.customTitle;
                    if (typeof ct === 'string' && ct) {
                        title = ct;
                    }
                    turnsFromEntry(entry, turns);
                } catch {
                    // skip malformed line
                }
            }
            if (turns.length === 0) {
                continue;
            }
            sessions++;
            const sess: SessionUsage = {
                sessionId: name.replace(/\.jsonl$/, ''),
                project,
                title: title || turns[0].snippet || '(untitled)',
                date: '',
                turns: 0,
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                peakInput: 0,
                peakModel: '',
                peakSnippet: '',
                peakFile: '',
                detail: []
            };
            for (const turn of turns) {
                accumulate(turn, project, sess);
            }
            if (sess.turns > 0) {
                sessionList.push(sess);
            }
        }
    }

    // Fold in agent-mode sessions (newer VS Code / Copilot store usage in
    // agentSessionData/<id>/session.db rather than chatSessions/*.jsonl).
    try {
        const agentSessions = await loadAgentSessions(scope);
        for (const a of agentSessions) {
            const sess: SessionUsage = {
                sessionId: a.sessionId,
                project: a.project,
                title: a.title,
                date: '',
                turns: 0,
                inputTokens: 0,
                outputTokens: 0,
                costUsd: 0,
                peakInput: 0,
                peakModel: '',
                peakSnippet: '',
                peakFile: '',
                detail: []
            };
            for (const t of a.turns) {
                accumulate(
                    {
                        model: t.model,
                        input: t.input,
                        output: t.output,
                        responseId: t.turnId,
                        ts: a.dateMs,
                        snippet: a.snippet,
                        files: [],
                        cacheRead: t.cacheRead
                    },
                    a.project,
                    sess
                );
            }
            if (sess.turns > 0) {
                sessions++;
                sessionList.push(sess);
            }
        }
    } catch {
        // agent-session store unavailable — keep legacy results
    }

    const perModel = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd);
    const daily = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    const prices: Record<string, { input: number; output: number }> = {};
    for (const m of byModel.keys()) {
        const { price } = priceForModel(m);
        prices[m] = { input: price.input, output: price.output };
    }
    const peakDay = daily.reduce<{ date: string; costUsd: number } | undefined>(
        (best, d) => (!best || d.costUsd > best.costUsd ? { date: d.date, costUsd: d.costUsd } : best),
        undefined
    );
    return {
        generatedAt: new Date().toISOString(),
        scope,
        sessionsScanned: sessions,
        totalTurns: perModel.reduce((s, m) => s + m.turns, 0),
        totalInput: perModel.reduce((s, m) => s + m.inputTokens, 0),
        totalOutput: perModel.reduce((s, m) => s + m.outputTokens, 0),
        totalCostUsd: perModel.reduce((s, m) => s + m.costUsd, 0),
        perModel,
        perProject: [...byProject.values()].sort((a, b) => b.costUsd - a.costUsd),
        daily,
        activeDays: daily.length,
        peakDay,
        cells: [...byCell.values()],
        sessions: sessionList.sort((a, b) => b.inputTokens - a.inputTokens).slice(0, 100),
        prices
    };
}
