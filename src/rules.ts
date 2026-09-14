import * as vscode from 'vscode';
import { suggestCheaperModel, fmtUsd } from './pricing';
import { personalizedSnowballThreshold } from './history';

export interface RuleFinding {
    icon: string;
    title: string;
    detail: string;
}

export interface RuleInput {
    promptText: string;
    referenceCount: number;
    referencesLookWholeWorkspace: boolean;
    modelId: string;
    contextTokens: number;
    projectedOutput: number;
    prevContextTokens: number | undefined;
    isDuplicate: boolean;
    duplicateSimilarity: number;
    historicalDuplicate?: { score: number; project: string; date: string };
}

function cfg() {
    return vscode.workspace.getConfiguration('tokenguard');
}

/** Rule 0 — duplicate / near-duplicate of an earlier prompt this session. */
function ruleDuplicate(i: RuleInput): RuleFinding | undefined {
    if (!i.isDuplicate) {
        return undefined;
    }
    const pct = Math.round(i.duplicateSimilarity * 100);
    return {
        icon: '♻️',
        title: 'Duplicate request detected',
        detail:
            `This is ${pct}% similar to something you already asked this session. ` +
            `Re-running re-pays the full input + output cost for an answer you likely already have. ` +
            `Scroll up to reuse it, or reset the session if you want a fresh run.`
    };
}

/** Rule 0b — near-duplicate of a prompt from an earlier session (cross-session). */
function ruleHistoricalDuplicate(i: RuleInput): RuleFinding | undefined {
    if (i.isDuplicate || !i.historicalDuplicate) {
        return undefined;
    }
    const h = i.historicalDuplicate;
    return {
        icon: '🕒',
        title: 'Asked before in a past session',
        detail:
            `This is ~${Math.round(h.score * 100)}% similar to a prompt from “${h.project}” (${h.date || 'earlier'}). ` +
            `You may already have the answer — check that session (TokenGuard dashboard → Top Sessions) before re-paying input + output for it.`
    };
}

/** Rule 1 — too many files / whole workspace attached. */
function ruleWorkspaceAttached(i: RuleInput): RuleFinding | undefined {
    const max = cfg().get<number>('maxAttachedReferences', 5);
    if (i.referencesLookWholeWorkspace) {
        return {
            icon: '📁',
            title: 'Whole workspace attached',
            detail: 'You attached the entire workspace. The agent re-reads all of it every turn. Attach only the 2–5 files this task needs.'
        };
    }
    if (i.referenceCount > max) {
        return {
            icon: '📁',
            title: `${i.referenceCount} context references attached`,
            detail: `More than ${max} files are attached. Each is re-sent as input on every turn — trim to just what the task needs.`
        };
    }
    return undefined;
}

/** Rule 2 — context snowball: context growing turn over turn. */
function ruleSnowball(i: RuleInput): RuleFinding | undefined {
    if (i.prevContextTokens === undefined) {
        return undefined;
    }
    const growth = i.contextTokens - i.prevContextTokens;
    // Prefer a threshold learned from your own history (p90 growth/turn); fall back to config.
    const threshold = personalizedSnowballThreshold() ?? cfg().get<number>('snowballGrowthTokens', 4000);
    if (growth > threshold) {
        return {
            icon: '❄️',
            title: 'Context snowball detected',
            detail: `Context grew by ~${growth.toLocaleString()} tokens since the last turn (your typical ceiling is ~${threshold.toLocaleString()}). Consider summarising the thread or starting a fresh chat — you re-pay for all accumulated history on every turn.`
        };
    }
    return undefined;
}

/** Rule 3 — sensitive data in the prompt (user-configured patterns only). */
function ruleSensitive(i: RuleInput): RuleFinding | undefined {
    const patterns = cfg().get<string[]>('sensitivePatterns', []);
    if (patterns.length === 0) {
        return undefined;
    }
    const hits: string[] = [];
    for (const p of patterns) {
        try {
            const re = new RegExp(p.replace(/^\(\?i\)/, ''), p.startsWith('(?i)') ? 'i' : undefined);
            if (re.test(i.promptText)) {
                hits.push(p);
            }
        } catch {
            // ignore invalid pattern
        }
    }
    if (hits.length > 0) {
        return {
            icon: '🔐',
            title: 'Possible sensitive data in prompt',
            detail: 'Your prompt matches one of your configured sensitive-data patterns. Avoid pasting credentials or confidential data — it can also be exposed via shared prompt caches. Redact before sending.'
        };
    }
    return undefined;
}

/** Rule 4 — cache-unfriendly prompt ordering (variable content before stable instructions). */
function ruleCacheUnfriendly(i: RuleInput): RuleFinding | undefined {
    const text = i.promptText.trimStart();
    // Heuristic: a large code/data block or file path at the very start means the
    // stable instruction (if any) comes after the variable content, defeating
    // exact-prefix caching.
    const startsWithBlock = /^```/.test(text) || /^[A-Za-z]:\\|^\//.test(text);
    const bigVariableLede = text.length > 600 && !/^(you are|your task|instructions?:|role:|context:)/i.test(text);
    if (startsWithBlock || bigVariableLede) {
        return {
            icon: '🧊',
            title: 'Cache-unfriendly prompt order',
            detail: 'Variable content appears before your stable instructions. Put stable text (role, conventions, tool defs) first and the changing code/data last so the provider can cache the prefix (~10% cost on re-reads).'
        };
    }
    return undefined;
}

/** Rule 5 — overkill model for a trivial task. */
function ruleOverkillModel(i: RuleInput): RuleFinding | undefined {
    const cheapHints = cfg().get<string[]>('cheapModelHints', []);
    const isCheap = cheapHints.some(h => i.modelId.toLowerCase().includes(h.toLowerCase()));
    if (isCheap) {
        return undefined;
    }
    // Signals that the task genuinely needs a frontier/reasoning model.
    const hardSignals = /\b(architect|design|debug|root cause|why does|vulnerab|security|prove|optimi[sz]e|concurren|race condition|trade-?off|refactor the|complex|algorithm|reason about|analy[sz]e deeply)\b/i;
    const trivialSignals = /\b(format|reformat|rename|typo|comment|indent|lint|prettify|boilerplate|stub|getter|setter|import|spelling|count|list|find|how many|show|read|check|summari[sz]e)\b/i;

    const looksTrivial = trivialSignals.test(i.promptText);
    const looksHard = hardSignals.test(i.promptText);

    // Fire when the request is either explicitly routine, or simply not
    // hard-reasoning — and a materially cheaper model exists for it.
    if ((looksTrivial || !looksHard) && i.promptText.length < 600) {
        const suggestion = suggestCheaperModel(i.modelId, i.contextTokens, i.projectedOutput);
        if (!suggestion) {
            return undefined; // no cheaper option worth flagging
        }
        return {
            icon: '💸',
            title: 'Cheaper model likely enough for this task',
            detail:
                `This doesn't look like hard reasoning but is running on "${i.modelId}". ` +
                `Try **${suggestion.model}**: ~${fmtUsd(suggestion.cheaperCost)} vs ${fmtUsd(suggestion.currentCost)} — ` +
                `saves ${fmtUsd(suggestion.savings)} (${Math.round(suggestion.savingsPct * 100)}%) on this request. ` +
                `Reserve the frontier model for architecture, debugging, and genuinely hard reasoning.`
        };
    }
    return undefined;
}

/** Rule 6 — generative ask with no brevity / output cap. */
function ruleNoOutputCap(i: RuleInput): RuleFinding | undefined {
    const generative = /\b(write|generate|create|implement|draft|explain|produce|build|refactor|document)\b/i.test(i.promptText);
    const hasCap = /\b(brief|concise|short|only|just|no explanation|diff only|patch only|bullet|<\s*\d+\s*(words|lines|tokens))\b/i.test(i.promptText);
    if (generative && !hasCap && i.promptText.length < 2000) {
        return {
            icon: '📏',
            title: 'No output cap requested',
            detail: 'Output tokens cost ~4–6× input. Add a brevity instruction (e.g. "diff only", "be concise", "≤ 20 lines") — the model defaults to verbose otherwise.'
        };
    }
    return undefined;
}

const RULES: Array<(i: RuleInput) => RuleFinding | undefined> = [
    ruleDuplicate,
    ruleHistoricalDuplicate,
    ruleWorkspaceAttached,
    ruleSnowball,
    ruleSensitive,
    ruleCacheUnfriendly,
    ruleOverkillModel,
    ruleNoOutputCap
];

export function runRules(input: RuleInput): RuleFinding[] {
    const findings: RuleFinding[] = [];
    for (const rule of RULES) {
        const f = rule(input);
        if (f) {
            findings.push(f);
        }
    }
    return findings;
}
