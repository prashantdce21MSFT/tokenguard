import * as vscode from 'vscode';

/**
 * Appends per-turn usage records as JSON Lines using OpenTelemetry GenAI
 * semantic-convention attribute names, so an OTel collector or your
 * Observability Hub can ingest agent cost telemetry alongside other signals.
 *
 * File: <workspaceRoot>/.tokenguard/usage.jsonl
 */

export interface UsageRecord {
    model: string;
    operation: string;
    inputTokens: number;
    outputTokens: number;
    toolResultTokens: number;
    costUsd: number;
    inputCostUsd: number;
    outputCostUsd: number;

    // Latency
    durationMs: number;
    timeToFirstTokenMs: number;
    finishReason: string;

    // Agent-loop behaviour
    toolCallsCount: number;
    toolNames: string[];
    loopIterations: number;
    loopHitCap: boolean;
    forcedFinalAnswer: boolean;

    // Savings realised by TokenGuard
    tokensSavedByCompaction: number;
    tokensSavedByDuplicate: number;
    tokensSavedByTiering: number;
    suggestedCheaperModel?: string;
    potentialSavingsUsd?: number;

    // Attribution
    sessionId: string;
    turnIndex: number;
    workspace: string;
    budgetSessionPct: number;
    budgetDailyPct: number;

    // Flags
    findings: string[];
    duplicate: boolean;
    compacted: boolean;
    reasoning: boolean;
}

export async function logUsage(record: UsageRecord): Promise<void> {
    const enabled = vscode.workspace.getConfiguration('tokenguard').get<boolean>('usageLogEnabled', true);
    if (!enabled) {
        return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
        return;
    }

    const dir = vscode.Uri.joinPath(root, '.tokenguard');
    const file = vscode.Uri.joinPath(dir, 'usage.jsonl');

    const payload: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        'gen_ai.system': 'vscode.copilot',
        'gen_ai.operation.name': record.operation,
        'gen_ai.request.model': record.model,
        'gen_ai.response.finish_reasons': [record.finishReason],
        'gen_ai.usage.input_tokens': record.inputTokens,
        'gen_ai.usage.output_tokens': record.outputTokens,
        'gen_ai.usage.total_tokens': record.inputTokens + record.outputTokens,
        'gen_ai.server.time_to_first_token_ms': record.timeToFirstTokenMs,
        'gen_ai.client.operation.duration_ms': record.durationMs,

        'tokenguard.cost_usd': round(record.costUsd),
        'tokenguard.input_cost_usd': round(record.inputCostUsd),
        'tokenguard.output_cost_usd': round(record.outputCostUsd),
        'tokenguard.tool_result_tokens': record.toolResultTokens,

        'tokenguard.tool_calls_count': record.toolCallsCount,
        'tokenguard.tool_names': record.toolNames,
        'tokenguard.loop_iterations': record.loopIterations,
        'tokenguard.loop_hit_cap': record.loopHitCap,
        'tokenguard.forced_final_answer': record.forcedFinalAnswer,

        'tokenguard.tokens_saved_by_compaction': record.tokensSavedByCompaction,
        'tokenguard.tokens_saved_by_duplicate_block': record.tokensSavedByDuplicate,
        'tokenguard.tokens_saved_by_tiering': record.tokensSavedByTiering,
        'tokenguard.suggested_cheaper_model': record.suggestedCheaperModel ?? null,
        'tokenguard.potential_savings_usd': record.potentialSavingsUsd != null ? round(record.potentialSavingsUsd) : null,

        'tokenguard.session_id': record.sessionId,
        'tokenguard.turn_index': record.turnIndex,
        'tokenguard.workspace': record.workspace,
        'tokenguard.budget_session_pct': Math.round(record.budgetSessionPct * 100),
        'tokenguard.budget_daily_pct': Math.round(record.budgetDailyPct * 100),

        'tokenguard.findings': record.findings,
        'tokenguard.duplicate': record.duplicate,
        'tokenguard.compacted': record.compacted,
        'tokenguard.reasoning_model': record.reasoning
    };

    const line = JSON.stringify(payload) + '\n';

    try {
        await vscode.workspace.fs.createDirectory(dir);
        let existing = '';
        try {
            const bytes = await vscode.workspace.fs.readFile(file);
            existing = new TextDecoder('utf-8').decode(bytes);
        } catch {
            // file does not exist yet
        }
        const data = new TextEncoder().encode(existing + line);
        await vscode.workspace.fs.writeFile(file, data);
    } catch {
        // logging must never break the chat flow
    }
}

function round(n: number): number {
    return Number(n.toFixed(6));
}
