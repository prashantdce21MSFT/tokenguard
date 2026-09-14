import * as vscode from 'vscode';

/**
 * Builds a requestId -> modelId map from this workspace's chat transcripts
 * (chatSessions/*.json), so edit operations can be attributed to the model
 * that produced them. Newer VS Code transcripts store `modelId` (e.g.
 * "copilot/claude-3.5-sonnet") at the request level alongside `requestId`.
 */

export type RequestModelMap = Map<string, string>;

function normalizeModel(modelId: string): string {
    // "copilot/claude-3.5-sonnet" -> "claude-3.5-sonnet"
    const slash = modelId.lastIndexOf('/');
    return (slash >= 0 ? modelId.slice(slash + 1) : modelId).trim();
}

export async function buildRequestModelMap(storageUri: vscode.Uri | undefined): Promise<RequestModelMap> {
    const map: RequestModelMap = new Map();
    if (!storageUri) {
        return map;
    }
    // storageUri = .../workspaceStorage/<hash>/<publisher.ext>; parent = <hash>.
    const chatDir = vscode.Uri.joinPath(storageUri, '..', 'chatSessions');
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(chatDir);
    } catch {
        return map;
    }
    for (const [name, type] of entries) {
        if (type !== vscode.FileType.File || !name.endsWith('.json')) {
            continue;
        }
        try {
            const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(chatDir, name));
            const json = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as {
                requests?: Array<{ requestId?: unknown; modelId?: unknown }>;
            };
            const requests = Array.isArray(json.requests) ? json.requests : [];
            for (const r of requests) {
                if (typeof r.requestId === 'string' && typeof r.modelId === 'string' && r.modelId) {
                    map.set(r.requestId, normalizeModel(r.modelId));
                }
            }
        } catch {
            // skip unreadable/legacy transcript
        }
    }
    return map;
}
