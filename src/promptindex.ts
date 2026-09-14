import * as vscode from 'vscode';

/**
 * Builds an index of your past prompt texts from chatSessions/*.jsonl so the
 * live coach can warn when a new prompt is a near-duplicate of something you
 * already asked in an EARLIER session (not just the current one).
 */

interface HistPrompt {
    norm: string;
    tokens: Set<string>;
    project: string;
    date: string;
}

export interface HistoricalMatch {
    score: number;
    project: string;
    date: string;
}

let index: HistPrompt[] = [];
let buildPromise: Promise<void> | undefined;

/** Ensure the index is built once, awaiting the first build. Safe to await every turn. */
export function ensurePromptIndex(storageUri: vscode.Uri | undefined): Promise<void> {
    if (!buildPromise) {
        buildPromise = buildPromptIndex(storageUri);
    }
    return buildPromise;
}

function normalize(text: string): string {
    return text.toLowerCase().replace(/```[\s\S]*?```/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function tokenize(norm: string): Set<string> {
    return new Set(norm.split(' ').filter(w => w.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) {
        return 0;
    }
    let inter = 0;
    for (const w of a) {
        if (b.has(w)) {
            inter++;
        }
    }
    return inter / (a.size + b.size - inter);
}

async function projectForHash(hashDir: vscode.Uri): Promise<string> {
    try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(hashDir, 'workspace.json'));
        const json = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as { folder?: string; workspace?: string };
        const uri = json.folder ?? json.workspace;
        if (uri) {
            const seg = decodeURIComponent(uri).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
            if (seg) {
                return seg;
            }
        }
    } catch {
        // no workspace.json
    }
    return 'a past session';
}

function promptsFromEntry(entry: unknown, date: string, project: string, out: HistPrompt[]): void {
    const requests = (entry as { v?: { requests?: unknown[] } })?.v?.requests;
    if (!Array.isArray(requests)) {
        return;
    }
    for (const raw of requests) {
        const req = raw as { message?: unknown; timestamp?: unknown };
        const msg = req.message as { text?: unknown } | string | undefined;
        const text = typeof msg === 'string' ? msg : (typeof msg?.text === 'string' ? msg.text : '');
        if (!text) {
            continue;
        }
        const norm = normalize(text);
        const tokens = tokenize(norm);
        // Skip trivial prompts ("run it again") that would false-positive.
        if (tokens.size < 4) {
            continue;
        }
        let d = date;
        if (typeof req.timestamp === 'number' && req.timestamp > 0) {
            const dt = new Date(req.timestamp);
            d = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        }
        out.push({ norm, tokens, project, date: d });
    }
}

/** Scan all workspaces' transcripts and (re)build the prompt index. */
export async function buildPromptIndex(storageUri: vscode.Uri | undefined, maxPrompts = 4000): Promise<void> {
    if (!storageUri) {
        return;
    }
    const storageRoot = vscode.Uri.joinPath(storageUri, '..', '..');
    const all: HistPrompt[] = [];
    let hashes: [string, vscode.FileType][];
    try {
        hashes = await vscode.workspace.fs.readDirectory(storageRoot);
    } catch {
        return;
    }
    for (const [hash, type] of hashes) {
        if (type !== vscode.FileType.Directory) {
            continue;
        }
        const hashDir = vscode.Uri.joinPath(storageRoot, hash);
        const chatDir = vscode.Uri.joinPath(hashDir, 'chatSessions');
        let files: [string, vscode.FileType][];
        try {
            files = await vscode.workspace.fs.readDirectory(chatDir);
        } catch {
            continue;
        }
        const project = await projectForHash(hashDir);
        for (const [name, ft] of files) {
            if (ft !== vscode.FileType.File || !name.endsWith('.jsonl')) {
                continue;
            }
            try {
                const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(chatDir, name));
                const text = new TextDecoder('utf-8').decode(bytes);
                for (const line of text.split('\n')) {
                    const t = line.trim();
                    if (t) {
                        try {
                            promptsFromEntry(JSON.parse(t), '', project, all);
                        } catch {
                            // skip malformed
                        }
                    }
                }
            } catch {
                // skip unreadable
            }
        }
    }
    // Keep the most recent prompts, deduped by normalized text.
    const seen = new Set<string>();
    const deduped: HistPrompt[] = [];
    for (const p of all.sort((a, b) => b.date.localeCompare(a.date))) {
        if (!seen.has(p.norm)) {
            seen.add(p.norm);
            deduped.push(p);
        }
        if (deduped.length >= maxPrompts) {
            break;
        }
    }
    index = deduped;
}

/**
 * Return the best historical near-duplicate for a prompt, if any exceeds the
 * threshold. Ignores the current session (it's compared against past prompts).
 */
export function findHistoricalDuplicate(prompt: string, threshold = 0.7): HistoricalMatch | undefined {
    const norm = normalize(prompt);
    const tokens = tokenize(norm);
    if (tokens.size < 4) {
        return undefined;
    }
    let best: HistPrompt | undefined;
    let bestScore = 0;
    for (const p of index) {
        // An exact-normalized match from the same open chat would score 1; that's
        // still useful ("you asked this verbatim before").
        const s = jaccard(tokens, p.tokens);
        if (s > bestScore) {
            bestScore = s;
            best = p;
        }
    }
    if (best && bestScore >= threshold) {
        return { score: bestScore, project: best.project, date: best.date };
    }
    return undefined;
}
