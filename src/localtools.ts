import * as vscode from 'vscode';

/**
 * TokenGuard's own workspace tools. Copilot's built-in file/search tools are
 * private to Copilot and not exposed to third-party chat participants, so we
 * define and execute our own here using the VS Code workspace file APIs.
 */

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.vscode-test', 'bin', 'obj']);
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 200_000;

export function getLocalTools(): vscode.LanguageModelChatTool[] {
    return [
        {
            name: 'tg_list_dir',
            description: 'List files and folders within a directory in the workspace. Paths are relative to the workspace root.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Directory path relative to the workspace root. Use "." for the root.' }
                },
                required: ['path']
            }
        },
        {
            name: 'tg_read_file',
            description: 'Read the text contents of a file in the workspace. Paths are relative to the workspace root.',
            inputSchema: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'File path relative to the workspace root.' }
                },
                required: ['path']
            }
        },
        {
            name: 'tg_grep',
            description: 'Search the workspace for a text or regex pattern. Returns matching file:line: text entries.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'The text or regular expression to search for.' },
                    isRegex: { type: 'boolean', description: 'Whether query is a regular expression. Default false.' },
                    glob: { type: 'string', description: 'Optional glob filter, e.g. **/*.ps1' }
                },
                required: ['query']
            }
        },
        {
            name: 'tg_find_files',
            description: 'Find files by glob pattern in the workspace, e.g. **/*.ps1 or src/**.',
            inputSchema: {
                type: 'object',
                properties: {
                    glob: { type: 'string', description: 'Glob pattern to match file paths.' }
                },
                required: ['glob']
            }
        }
    ];
}

export function isLocalTool(name: string): boolean {
    return name.startsWith('tg_');
}

function root(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function resolve(rel: string): vscode.Uri | undefined {
    const r = root();
    if (!r) {
        return undefined;
    }
    return vscode.Uri.joinPath(r, rel.replace(/^[./\\]+/, ''));
}

export async function executeLocalTool(name: string, input: any): Promise<string> {
    const r = root();
    if (!r) {
        return 'No workspace folder is open, so TokenGuard cannot inspect files. Ask the user to open the folder.';
    }
    try {
        switch (name) {
            case 'tg_list_dir':
                return await listDir(input?.path ?? '.');
            case 'tg_read_file':
                return await readFile(input?.path ?? '');
            case 'tg_grep':
                return await grep(input?.query ?? '', !!input?.isRegex, input?.glob);
            case 'tg_find_files':
                return await findFiles(input?.glob ?? '**/*');
            default:
                return `Unknown tool ${name}.`;
        }
    } catch (err) {
        return `Tool ${name} failed: ${String(err)}`;
    }
}

async function listDir(rel: string): Promise<string> {
    const uri = resolve(rel);
    if (!uri) {
        return 'No workspace open.';
    }
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const lines: string[] = [];
    for (const [n, type] of entries) {
        if (type === vscode.FileType.Directory) {
            lines.push(`${n}/`);
            // Peek one level into subfolders (skipping noise) so the model can
            // discover nested files like logs/run_2026-07-25.log in one step.
            if (!SKIP_DIRS.has(n)) {
                try {
                    const sub = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(uri, n));
                    for (const [sn, st] of sub.slice(0, 40)) {
                        lines.push(`  ${n}/${sn}${st === vscode.FileType.Directory ? '/' : ''}`);
                    }
                    if (sub.length > 40) {
                        lines.push(`  …(${sub.length - 40} more in ${n}/)`);
                    }
                } catch {
                    // ignore unreadable subfolder
                }
            }
        } else {
            lines.push(n);
        }
    }
    return lines.length ? `Contents of ${rel}:\n${lines.join('\n')}` : `${rel} is empty.`;
}

async function readFile(rel: string): Promise<string> {
    const uri = resolve(rel);
    if (!uri) {
        return 'No workspace open.';
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    const slice = bytes.length > MAX_FILE_BYTES ? bytes.slice(0, MAX_FILE_BYTES) : bytes;
    const text = new TextDecoder('utf-8').decode(slice);
    const truncated = bytes.length > MAX_FILE_BYTES ? '\n…[truncated]' : '';
    return `File ${rel}:\n${text}${truncated}`;
}

async function findFiles(glob: string): Promise<string> {
    const files = await vscode.workspace.findFiles(glob, `{${[...SKIP_DIRS].map(d => `**/${d}/**`).join(',')}}`, 500);
    if (!files.length) {
        return `No files match ${glob}.`;
    }
    const rootPath = root()!.path;
    return `Files matching ${glob}:\n` + files.map(f => f.path.replace(rootPath + '/', '')).join('\n');
}

async function grep(query: string, isRegex: boolean, glob?: string): Promise<string> {
    let re: RegExp;
    try {
        re = new RegExp(isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    } catch {
        return `Invalid regex: ${query}`;
    }
    const files = await vscode.workspace.findFiles(
        glob ?? '**/*',
        `{${[...SKIP_DIRS].map(d => `**/${d}/**`).join(',')}}`,
        2000
    );
    const rootPath = root()!.path;
    const matches: string[] = [];
    for (const f of files) {
        if (matches.length >= MAX_MATCHES) {
            break;
        }
        let bytes: Uint8Array;
        try {
            bytes = await vscode.workspace.fs.readFile(f);
        } catch {
            continue;
        }
        if (bytes.length > MAX_FILE_BYTES) {
            continue;
        }
        const text = new TextDecoder('utf-8').decode(bytes);
        const lines = text.split(/\r?\n/);
        const relPath = f.path.replace(rootPath + '/', '');
        for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
                matches.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (matches.length >= MAX_MATCHES) {
                    break;
                }
            }
        }
    }
    return matches.length
        ? `Matches for "${query}":\n${matches.join('\n')}`
        : `No matches for "${query}".`;
}
