import * as vscode from 'vscode';
import { calibratedReasoningMultiplier } from './history';

/** USD price per 1,000,000 tokens. */
export interface ModelPrice {
    input: number;
    output: number;
}

/**
 * Default per-million-token prices (USD). Keys are lowercase substrings matched
 * against the model id/family. First match wins, so list more specific keys first.
 * Users can override or extend via the `tokenguard.modelPrices` setting.
 */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
    'gpt-4o-mini': { input: 0.15, output: 0.60 },
    'gpt-4o': { input: 2.50, output: 10.0 },
    'gpt-4.1-mini': { input: 0.40, output: 1.60 },
    'gpt-4.1': { input: 2.00, output: 8.00 },
    'o4-mini': { input: 1.10, output: 4.40 },
    'o3': { input: 2.00, output: 8.00 },
    'gpt-5-mini': { input: 0.25, output: 2.00 },
    'gpt-5': { input: 1.25, output: 10.0 },
    'claude-3-haiku': { input: 0.25, output: 1.25 },
    'haiku': { input: 0.80, output: 4.00 },
    'claude-3-5-sonnet': { input: 3.00, output: 15.0 },
    'sonnet': { input: 3.00, output: 15.0 },
    'opus': { input: 15.0, output: 75.0 },
    'gemini-1.5-flash': { input: 0.075, output: 0.30 },
    'flash': { input: 0.15, output: 0.60 },
    'gemini-1.5-pro': { input: 1.25, output: 5.00 },
    'gemini': { input: 1.25, output: 5.00 }
};

const FALLBACK: ModelPrice = { input: 2.0, output: 8.0 };

function priceTable(): Record<string, ModelPrice> {
    const override = vscode.workspace
        .getConfiguration('tokenguard')
        .get<Record<string, ModelPrice>>('modelPrices', {});
    return { ...DEFAULT_PRICES, ...override };
}

/** Resolve the price for a model id/family via substring match. */
export function priceForModel(modelId: string): { price: ModelPrice; matched: string | undefined } {
    const id = (modelId ?? '').toLowerCase();
    const table = priceTable();
    // Prefer the longest matching key so "gpt-4o-mini" beats "gpt-4o".
    const keys = Object.keys(table).sort((a, b) => b.length - a.length);
    for (const k of keys) {
        if (id.includes(k)) {
            return { price: table[k], matched: k };
        }
    }
    return { price: FALLBACK, matched: undefined };
}

/** Cost in USD for a given input/output token split on a model. */
export function costUsd(modelId: string, inputTokens: number, outputTokens: number): number {
    const { price } = priceForModel(modelId);
    return (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
}

/**
 * Cost with an OPT-IN prompt-cache assumption. Copilot does not expose the
 * cache-read/input split, so this is a user-controlled estimate, not ground
 * truth: `assumedCacheReadFraction` (default 0 = off) of input is billed at
 * `cacheReadPriceMultiplier` (default 0.1) of the input rate. With defaults it
 * equals the plain list-price upper bound.
 */
export function costUsdWithCache(modelId: string, inputTokens: number, outputTokens: number): number {
    const cfg = vscode.workspace.getConfiguration('tokenguard');
    const frac = Math.max(0, Math.min(1, cfg.get<number>('assumedCacheReadFraction', 0)));
    const mult = Math.max(0, cfg.get<number>('cacheReadPriceMultiplier', 0.1));
    const { price } = priceForModel(modelId);
    const cached = inputTokens * frac;
    const fresh = inputTokens - cached;
    return (
        (fresh / 1_000_000) * price.input +
        (cached / 1_000_000) * price.input * mult +
        (outputTokens / 1_000_000) * price.output
    );
}

/** Input/output cost split (USD), honouring the same cache assumption as costUsdWithCache. */
export function costSplitWithCache(modelId: string, inputTokens: number, outputTokens: number): { input: number; output: number } {
    const cfg = vscode.workspace.getConfiguration('tokenguard');
    const frac = Math.max(0, Math.min(1, cfg.get<number>('assumedCacheReadFraction', 0)));
    const mult = Math.max(0, cfg.get<number>('cacheReadPriceMultiplier', 0.1));
    const { price } = priceForModel(modelId);
    const cached = inputTokens * frac;
    const fresh = inputTokens - cached;
    return {
        input: (fresh / 1_000_000) * price.input + (cached / 1_000_000) * price.input * mult,
        output: (outputTokens / 1_000_000) * price.output
    };
}

/** The effective price table (defaults + user overrides), for client-side what-if math. */
export function allPrices(): Record<string, ModelPrice> {
    return priceTable();
}

/**
 * Cost using the REAL prompt-cache split reported by newer Copilot agent
 * sessions. `inputTokens` is the total input (which already includes
 * `cacheReadTokens`); cached reads are billed at `cacheReadPriceMultiplier`
 * (default 0.1) of the input rate, the remainder at the full input rate.
 */
export function costUsdRealCache(modelId: string, inputTokens: number, cacheReadTokens: number, outputTokens: number): number {
    const s = costSplitRealCache(modelId, inputTokens, cacheReadTokens, outputTokens);
    return s.input + s.output;
}

/** Input/output cost split (USD) honouring the real cache-read count. */
export function costSplitRealCache(modelId: string, inputTokens: number, cacheReadTokens: number, outputTokens: number): { input: number; output: number } {
    const mult = Math.max(0, vscode.workspace.getConfiguration('tokenguard').get<number>('cacheReadPriceMultiplier', 0.1));
    const { price } = priceForModel(modelId);
    const cached = Math.max(0, Math.min(inputTokens, cacheReadTokens));
    const fresh = inputTokens - cached;
    return {
        input: (fresh / 1_000_000) * price.input + (cached / 1_000_000) * price.input * mult,
        output: (outputTokens / 1_000_000) * price.output
    };
}

/** True when the user has enabled a prompt-cache assumption. */
export function cacheAssumptionActive(): { active: boolean; fraction: number } {
    const frac = vscode.workspace.getConfiguration('tokenguard').get<number>('assumedCacheReadFraction', 0);
    return { active: frac > 0, fraction: Math.max(0, Math.min(1, frac)) };
}

/** Format a USD amount with sensible precision for small numbers. */
export function fmtUsd(amount: number): string {
    if (amount === 0) {
        return '$0';
    }
    if (amount < 0.01) {
        return `$${amount.toFixed(4)}`;
    }
    if (amount < 1) {
        return `$${amount.toFixed(3)}`;
    }
    return `$${amount.toFixed(2)}`;
}

/** Blended (input+output average) price per 1M tokens, for ranking models. */
function blended(p: ModelPrice): number {
    return (p.input + p.output) / 2;
}

export interface CheaperSuggestion {
    model: string;
    currentCost: number;
    cheaperCost: number;
    savings: number;
    savingsPct: number;
}

/**
 * If a materially cheaper model exists for this request, suggest it.
 * Returns undefined when the current model is already among the cheapest
 * or the saving is negligible.
 */
export function suggestCheaperModel(
    currentModelId: string,
    inputTokens: number,
    outputTokens: number
): CheaperSuggestion | undefined {
    const id = (currentModelId ?? '').toLowerCase();
    const { matched: currentKey } = priceForModel(currentModelId);
    const currentCost = costUsd(currentModelId, inputTokens, outputTokens);

    const table = priceTable();
    let bestKey: string | undefined;
    let bestCost = currentCost;

    for (const [key, price] of Object.entries(table)) {
        if (id.includes(key)) {
            continue; // don't suggest the model we're already on
        }
        const cost =
            (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
        // Prefer clearly cheaper options; tie-break on lower blended list price.
        if (cost < bestCost * 0.999) {
            if (!bestKey || cost < bestCost || blended(price) < blended(table[bestKey])) {
                bestKey = key;
                bestCost = cost;
            }
        }
    }

    if (!bestKey || currentKey === bestKey) {
        return undefined;
    }
    const savings = currentCost - bestCost;
    const savingsPct = currentCost > 0 ? savings / currentCost : 0;
    // Only surface if it saves at least ~40% and a non-trivial absolute amount.
    if (savingsPct < 0.4) {
        return undefined;
    }
    return { model: bestKey, currentCost, cheaperCost: bestCost, savings, savingsPct };
}

/**
 * Reasoning models emit hidden "thinking" tokens billed as output that the
 * response text does not expose, so token counts undercount. This returns the
 * multiplier TokenGuard applies to output to approximate the true cost.
 */
export function reasoningInfo(modelId: string): { isReasoning: boolean; multiplier: number } {
    const cfg = vscode.workspace.getConfiguration('tokenguard');
    const hints = cfg.get<string[]>('reasoningModelHints', [
        'opus', 'o1', 'o3', 'o4', 'gpt-5', 'reason', 'think'
    ]);
    const configMultiplier = cfg.get<number>('reasoningOutputMultiplier', 2.5);
    const id = (modelId ?? '').toLowerCase();
    const isReasoning = hints.some(h => id.includes(h.toLowerCase()));
    if (!isReasoning) {
        return { isReasoning, multiplier: 1 };
    }
    // Prefer a multiplier learned from your own history; fall back to the config default.
    const learned = calibratedReasoningMultiplier(modelId);
    return { isReasoning, multiplier: learned ?? configMultiplier };
}

/**
 * Copilot "credits" (premium-request multipliers) are a separate billing unit
 * from tokens. These are editable estimates — Microsoft's exact multipliers
 * change over time — overridable via `tokenguard.creditMultipliers`.
 */
const DEFAULT_CREDIT_MULTIPLIERS: Record<string, number> = {
    'gpt-4o-mini': 0,
    'gpt-4.1': 0,
    'gpt-4o': 1,
    'o4-mini': 1,
    'o3': 1,
    'gpt-5-mini': 1,
    'gpt-5': 1,
    'haiku': 1,
    'claude-3-5-sonnet': 1,
    'sonnet': 1,
    'opus': 10,
    'gemini-1.5-flash': 0,
    'flash': 0.25,
    'gemini': 1
};

export function creditMultiplier(modelId: string): { multiplier: number; matched?: string } {
    const override = vscode.workspace
        .getConfiguration('tokenguard')
        .get<Record<string, number>>('creditMultipliers', {});
    const table = { ...DEFAULT_CREDIT_MULTIPLIERS, ...override };
    const id = (modelId ?? '').toLowerCase();
    const keys = Object.keys(table).sort((a, b) => b.length - a.length);
    for (const k of keys) {
        if (id.includes(k)) {
            return { multiplier: table[k], matched: k };
        }
    }
    return { multiplier: 1 };
}


