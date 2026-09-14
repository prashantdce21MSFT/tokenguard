import * as vscode from 'vscode';
import { loadRealUsage } from './realusage';

/**
 * Reads TokenGuard's own historical usage log (.tokenguard/usage.jsonl) and
 * derives personalized empirical baselines that replace hard-coded constants:
 *   - per-model output/input ratio  -> a calibrated reasoning multiplier
 *   - per-session context growth     -> a personalized snowball threshold
 *
 * Honesty note: usage.jsonl stores TokenGuard's own per-turn numbers, not a
 * separate provider-billed value, so this is calibration to *your* behaviour,
 * not reconciliation against an invoice. It makes the live heuristics reflect
 * how you actually use models instead of generic defaults.
 */

export interface ModelStat {
    model: string;
    turns: number;
    avgInput: number;
    avgOutput: number;
    /** Mean output tokens per input token for this model. */
    outputInputRatio: number;
    avgCostUsd: number;
    reasoning: boolean;
}

export interface Calibration {
    generatedAt: string;
    totalTurns: number;
    perModel: Record<string, ModelStat>;
    /** Weighted output/input ratio across non-reasoning turns — the "plain work" baseline. */
    baselineRatio: number | undefined;
    /** 90th-percentile positive context growth between consecutive turns of a session. */
    snowballP90: number | undefined;
    /** Fraction of turns flagged as duplicates historically. */
    duplicateRate: number;
    /** True when per-model baselines come from Copilot's real token counts. */
    realBacked: boolean;
}

interface ParsedTurn {
    model: string;
    input: number;
    output: number;
    cost: number;
    sessionId: string;
    turnIndex: number;
    reasoning: boolean;
    duplicate: boolean;
}

let active: Calibration | undefined;

/** The most recently computed calibration, if any. */
export function getCalibration(): Calibration | undefined {
    return active;
}

function num(v: unknown): number {
    return typeof v === 'number' && isFinite(v) ? v : 0;
}

function parseLine(line: string): ParsedTurn | undefined {
    const t = line.trim();
    if (!t) {
        return undefined;
    }
    let o: Record<string, unknown>;
    try {
        o = JSON.parse(t) as Record<string, unknown>;
    } catch {
        return undefined;
    }
    const model = String(o['gen_ai.request.model'] ?? 'unknown');
    return {
        model,
        input: num(o['gen_ai.usage.input_tokens']),
        output: num(o['gen_ai.usage.output_tokens']),
        cost: num(o['tokenguard.cost_usd']),
        sessionId: String(o['tokenguard.session_id'] ?? ''),
        turnIndex: num(o['tokenguard.turn_index']),
        reasoning: o['tokenguard.reasoning_model'] === true,
        duplicate: o['tokenguard.duplicate'] === true
    };
}

async function readTurns(): Promise<ParsedTurn[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
        return [];
    }
    const file = vscode.Uri.joinPath(root, '.tokenguard', 'usage.jsonl');
    let text: string;
    try {
        const bytes = await vscode.workspace.fs.readFile(file);
        text = new TextDecoder('utf-8').decode(bytes);
    } catch {
        return [];
    }
    const turns: ParsedTurn[] = [];
    for (const line of text.split('\n')) {
        const p = parseLine(line);
        if (p) {
            turns.push(p);
        }
    }
    return turns;
}

function percentile(values: number[], p: number): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

function compute(turns: ParsedTurn[]): Calibration {
    const perModel: Record<string, ModelStat> = {};
    const byModel = new Map<string, ParsedTurn[]>();
    for (const t of turns) {
        const arr = byModel.get(t.model) ?? [];
        arr.push(t);
        byModel.set(t.model, arr);
    }

    for (const [model, arr] of byModel) {
        const n = arr.length;
        const sumIn = arr.reduce((s, t) => s + t.input, 0);
        const sumOut = arr.reduce((s, t) => s + t.output, 0);
        const sumCost = arr.reduce((s, t) => s + t.cost, 0);
        perModel[model] = {
            model,
            turns: n,
            avgInput: n ? sumIn / n : 0,
            avgOutput: n ? sumOut / n : 0,
            outputInputRatio: sumIn > 0 ? sumOut / sumIn : 0,
            avgCostUsd: n ? sumCost / n : 0,
            reasoning: arr.some(t => t.reasoning)
        };
    }

    // Baseline ratio from non-reasoning turns only (token-weighted).
    let baseIn = 0;
    let baseOut = 0;
    for (const t of turns) {
        if (!t.reasoning) {
            baseIn += t.input;
            baseOut += t.output;
        }
    }
    const baselineRatio = baseIn > 0 ? baseOut / baseIn : undefined;

    // Snowball p90: positive context growth between consecutive turns in a session.
    const bySession = new Map<string, ParsedTurn[]>();
    for (const t of turns) {
        if (!t.sessionId) {
            continue;
        }
        const arr = bySession.get(t.sessionId) ?? [];
        arr.push(t);
        bySession.set(t.sessionId, arr);
    }
    const growths: number[] = [];
    for (const arr of bySession.values()) {
        arr.sort((a, b) => a.turnIndex - b.turnIndex);
        for (let k = 1; k < arr.length; k++) {
            const d = arr[k].input - arr[k - 1].input;
            if (d > 0) {
                growths.push(d);
            }
        }
    }

    const dupCount = turns.filter(t => t.duplicate).length;

    return {
        generatedAt: new Date().toISOString(),
        totalTurns: turns.length,
        perModel,
        baselineRatio,
        snowballP90: percentile(growths, 90),
        duplicateRate: turns.length ? dupCount / turns.length : 0,
        realBacked: false
    };
}

function isReasoningModel(model: string): boolean {
    const hints = vscode.workspace.getConfiguration('tokenguard').get<string[]>('reasoningModelHints', [
        'opus', 'o1', 'o3', 'o4', 'gpt-5', 'reason', 'think'
    ]);
    const id = model.toLowerCase();
    return hints.some(h => id.includes(h.toLowerCase()));
}

/**
 * Read usage history, recompute calibration, cache it, and return it. When a
 * storage URI is provided, per-model baselines are rebuilt from Copilot's REAL
 * token counts (ground truth), keeping snowball/duplicate signals from the log.
 */
export async function loadCalibration(storageUri?: vscode.Uri): Promise<Calibration> {
    const turns = await readTurns();
    const base = compute(turns);

    if (storageUri) {
        try {
            const real = await loadRealUsage(storageUri, 'all');
            if (real.totalTurns > 0) {
                const perModel: Record<string, ModelStat> = {};
                let baseIn = 0;
                let baseOut = 0;
                for (const m of real.perModel) {
                    perModel[m.model] = {
                        model: m.model,
                        turns: m.turns,
                        avgInput: m.turns ? m.inputTokens / m.turns : 0,
                        avgOutput: m.turns ? m.outputTokens / m.turns : 0,
                        outputInputRatio: m.inputTokens > 0 ? m.outputTokens / m.inputTokens : 0,
                        avgCostUsd: m.turns ? m.costUsd / m.turns : 0,
                        reasoning: isReasoningModel(m.model)
                    };
                    if (!isReasoningModel(m.model)) {
                        baseIn += m.inputTokens;
                        baseOut += m.outputTokens;
                    }
                }
                active = {
                    generatedAt: new Date().toISOString(),
                    totalTurns: real.totalTurns,
                    perModel,
                    baselineRatio: baseIn > 0 ? baseOut / baseIn : base.baselineRatio,
                    snowballP90: base.snowballP90,
                    duplicateRate: base.duplicateRate,
                    realBacked: true
                };
                return active;
            }
        } catch {
            // fall through to log-based calibration
        }
    }

    active = base;
    return active;
}

/** Minimum turns for a model before its empirical stats are trusted. */
const MIN_TURNS = 8;

/**
 * A reasoning multiplier learned from *your* history: how much more output this
 * model produces per input token versus your non-reasoning baseline. Returns
 * undefined when there isn't enough data, so callers fall back to the config value.
 */
export function calibratedReasoningMultiplier(modelId: string): number | undefined {
    const cal = active;
    if (!cal || cal.baselineRatio === undefined || cal.baselineRatio <= 0) {
        return undefined;
    }
    const id = (modelId ?? '').toLowerCase();
    let stat: ModelStat | undefined;
    for (const s of Object.values(cal.perModel)) {
        if (id.includes(s.model.toLowerCase()) || s.model.toLowerCase().includes(id)) {
            if (!stat || s.turns > stat.turns) {
                stat = s;
            }
        }
    }
    if (!stat || stat.turns < MIN_TURNS || stat.outputInputRatio <= 0) {
        return undefined;
    }
    const ratio = stat.outputInputRatio / cal.baselineRatio;
    // Clamp to a sane range; never below 1 (we only inflate output).
    return Math.max(1, Math.min(5, Number(ratio.toFixed(2))));
}

/** Personalized snowball threshold (p90 of your historical per-turn growth). */
export function personalizedSnowballThreshold(): number | undefined {
    const cal = active;
    if (!cal || cal.snowballP90 === undefined) {
        return undefined;
    }
    if (cal.totalTurns < MIN_TURNS) {
        return undefined;
    }
    return Math.round(cal.snowballP90);
}

function fmtUsd(n: number): string {
    if (n < 0.01) {
        return `$${n.toFixed(4)}`;
    }
    return `$${n.toFixed(3)}`;
}

/** Human-readable Markdown report of the current calibration. */
export function formatCalibrationReport(cal: Calibration): string {
    const lines: string[] = [];
    lines.push('# TokenGuard — Personal Calibration');
    lines.push('');
    lines.push(`_Learned from ${cal.totalTurns.toLocaleString()} historical turns${cal.realBacked ? ' — **real Copilot token counts** (ground truth)' : ' in this workspace'}._`);
    lines.push('');
    if (cal.totalTurns === 0) {
        lines.push('No usage history found yet. Chat with `@tokenguard` a few times, then re-run this report.');
        return lines.join('\n');
    }
    lines.push(`- **Baseline output/input ratio** (non-reasoning): ${cal.baselineRatio !== undefined ? cal.baselineRatio.toFixed(2) : 'n/a'}`);
    lines.push(`- **Snowball p90 growth/turn**: ${cal.snowballP90 !== undefined ? cal.snowballP90.toLocaleString() + ' tokens' : 'n/a'}`);
    lines.push(`- **Historical duplicate rate**: ${Math.round(cal.duplicateRate * 100)}%`);
    lines.push('');
    lines.push('## Per-model baselines');
    lines.push('');
    lines.push('| Model | Turns | Avg in | Avg out | Out/In | Avg cost | Calibrated ×output |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    const stats = Object.values(cal.perModel).sort((a, b) => b.turns - a.turns);
    for (const s of stats) {
        const mult = calibratedReasoningMultiplier(s.model);
        lines.push(
            `| ${s.model} | ${s.turns} | ${Math.round(s.avgInput).toLocaleString()} | ` +
            `${Math.round(s.avgOutput).toLocaleString()} | ${s.outputInputRatio.toFixed(2)} | ` +
            `${fmtUsd(s.avgCostUsd)} | ${mult !== undefined ? mult.toFixed(2) + '×' : '—'} |`
        );
    }
    lines.push('');
    lines.push('_Calibrated multipliers and the snowball threshold feed the live rules automatically once a model has ≥ 8 turns of history._');
    return lines.join('\n');
}
