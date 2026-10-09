import * as vscode from 'vscode';

/**
 * Reads REAL per-turn token counts that newer VS Code / GitHub Copilot (agent
 * mode) persists to a SQLite database instead of the legacy
 * workspaceStorage/<hash>/chatSessions/*.jsonl files.
 *
 * Location:  <userDataDir>/agentSessionData/<sessionId>/session.db
 * Tokens:    table `turn_usage` (turn_id, usage) where usage is JSON
 *            { "inputTokens", "outputTokens", "model", "cacheReadTokens", ... }
 * Workspace: table `session_metadata` key `copilot.workingDirectory(ies)`.
 *
 * TokenGuard's original reader (realusage.ts) does not see this store, so on
 * recent VS Code builds the dashboard would show nothing. This module restores
 * ground-truth usage for those sessions.
 */

export interface AgentTurnData {
    turnId: string;
    model: string;
    input: number;
    output: number;
    cacheRead: number;
}

export interface AgentSessionData {
    sessionId: string;
    project: string;
    workingDir: string;
    title: string;
    snippet: string;
    dateMs: number;
    turns: AgentTurnData[];
}

let extensionUri: vscode.Uri | undefined;
let globalStorageUri: vscode.Uri | undefined;

export function initAgentSessions(context: vscode.ExtensionContext): void {
    extensionUri = context.extensionUri;
    globalStorageUri = context.globalStorageUri;
}

let sqlPromise: Promise<SqlJsStatic | undefined> | undefined;

interface SqlJsDatabase {
    exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
    close(): void;
}
interface SqlJsStatic {
    Database: new (data: Uint8Array) => SqlJsDatabase;
}

function getSql(): Promise<SqlJsStatic | undefined> {
    if (!sqlPromise) {
        sqlPromise = (async () => {
            if (!extensionUri) {
                return undefined;
            }
            try {
                const loaderPath = vscode.Uri.joinPath(extensionUri, 'media', 'sqljs', 'sql-wasm.js').fsPath;
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const initSqlJs = require(loaderPath) as (config?: { locateFile?: (f: string) => string }) => Promise<SqlJsStatic>;
                return await initSqlJs({
                    locateFile: (f: string) => vscode.Uri.joinPath(extensionUri!, 'media', 'sqljs', f).fsPath
                });
            } catch {
                return undefined;
            }
        })();
    }
    return sqlPromise;
}

/** <userDataDir>/agentSessionData, derived from the extension's global storage. */
function agentSessionRoot(): vscode.Uri | undefined {
    if (!globalStorageUri) {
        return undefined;
    }
    // globalStorageUri = <userData>/User/globalStorage/<publisher.ext>
    const userData = vscode.Uri.joinPath(globalStorageUri, '..', '..', '..');
    return vscode.Uri.joinPath(userData, 'agentSessionData');
}

function normalizeModel(modelId: string): string {
    const slash = modelId.lastIndexOf('/');
    return (slash >= 0 ? modelId.slice(slash + 1) : modelId).trim();
}

function num(v: unknown): number {
    return typeof v === 'number' && isFinite(v) ? v : 0;
}

/** Last path segment of a folder URI, decoded — the human project name. */
function projectFromUri(uri: string): string {
    try {
        const decoded = decodeURIComponent(uri);
        const seg = decoded.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        if (seg) {
            return seg;
        }
    } catch {
        // malformed uri
    }
    return 'unknown';
}

function normUri(uri: string): string {
    try {
        return decodeURIComponent(uri).replace(/[\\/]+$/, '').toLowerCase();
    } catch {
        return uri.replace(/[\\/]+$/, '').toLowerCase();
    }
}

function rows(db: SqlJsDatabase, sql: string): unknown[][] {
    try {
        const res = db.exec(sql);
        return res.length > 0 ? res[0].values : [];
    } catch {
        return [];
    }
}

function metaFromDb(db: SqlJsDatabase): Map<string, string> {
    const map = new Map<string, string>();
    for (const r of rows(db, 'SELECT key, value FROM session_metadata')) {
        if (typeof r[0] === 'string') {
            map.set(r[0], typeof r[1] === 'string' ? r[1] : '');
        }
    }
    return map;
}

function workingDirFromMeta(meta: Map<string, string>): string {
    const dirs = meta.get('copilot.workingDirectories');
    if (dirs) {
        try {
            const arr = JSON.parse(dirs) as unknown;
            if (Array.isArray(arr) && typeof arr[0] === 'string' && arr[0]) {
                return arr[0];
            }
        } catch {
            // not JSON
        }
    }
    return meta.get('copilot.workingDirectory')
        ?? meta.get('copilot.customizationDirectory')
        ?? '';
}

function turnsFromDb(db: SqlJsDatabase): AgentTurnData[] {
    const out: AgentTurnData[] = [];
    for (const r of rows(db, 'SELECT turn_id, usage FROM turn_usage')) {
        const turnId = typeof r[0] === 'string' ? r[0] : '';
        const usageRaw = typeof r[1] === 'string' ? r[1] : '';
        if (!usageRaw) {
            continue;
        }
        try {
            const u = JSON.parse(usageRaw) as {
                inputTokens?: unknown;
                outputTokens?: unknown;
                cacheReadTokens?: unknown;
                model?: unknown;
            };
            const input = num(u.inputTokens);
            const output = num(u.outputTokens);
            if (input === 0 && output === 0) {
                continue;
            }
            out.push({
                turnId: turnId || `turn:${out.length}`,
                model: normalizeModel(typeof u.model === 'string' ? u.model : 'unknown'),
                input,
                output,
                cacheRead: num(u.cacheReadTokens)
            });
        } catch {
            // skip unparseable usage row
        }
    }
    return out;
}

/**
 * Load agent-mode sessions. When scope is 'workspace', only sessions whose
 * working directory matches one of the currently open folders are returned.
 */
export async function loadAgentSessions(scope: 'workspace' | 'all'): Promise<AgentSessionData[]> {
    const root = agentSessionRoot();
    if (!root) {
        return [];
    }
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(root);
    } catch {
        return []; // store does not exist on this VS Code build
    }
    const SQL = await getSql();
    if (!SQL) {
        return [];
    }

    const openDirs = (vscode.workspace.workspaceFolders ?? []).map(f => normUri(f.uri.toString()));
    const result: AgentSessionData[] = [];

    for (const [name, type] of entries) {
        if (type !== vscode.FileType.Directory) {
            continue;
        }
        const dbUri = vscode.Uri.joinPath(root, name, 'session.db');
        let bytes: Uint8Array;
        let mtime = Date.now();
        try {
            const stat = await vscode.workspace.fs.stat(dbUri);
            mtime = stat.mtime;
            bytes = await vscode.workspace.fs.readFile(dbUri);
        } catch {
            continue; // no session.db in this folder
        }

        let db: SqlJsDatabase | undefined;
        try {
            db = new SQL.Database(bytes);
            const meta = metaFromDb(db);
            const workingDir = workingDirFromMeta(meta);
            if (scope === 'workspace' && openDirs.length > 0) {
                if (!workingDir || !openDirs.includes(normUri(workingDir))) {
                    continue;
                }
            }
            const turns = turnsFromDb(db);
            if (turns.length === 0) {
                continue;
            }
            result.push({
                sessionId: name,
                project: workingDir ? projectFromUri(workingDir) : 'unknown',
                workingDir,
                title: meta.get('customTitle') || '(agent session)',
                snippet: meta.get('customTitle') || '',
                dateMs: mtime,
                turns
            });
        } catch {
            // corrupt db — ignore
        } finally {
            try {
                db?.close();
            } catch {
                // ignore
            }
        }
    }
    return result;
}
