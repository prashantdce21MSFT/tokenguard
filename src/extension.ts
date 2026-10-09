import * as vscode from 'vscode';
import { BudgetTracker } from './budget';
import { runRules, RuleInput } from './rules';
import { costUsd, priceForModel, fmtUsd, reasoningInfo, suggestCheaperModel, creditMultiplier } from './pricing';
import { getLocalTools, isLocalTool, executeLocalTool } from './localtools';
import { logUsage } from './usagelog';
import { loadCalibration } from './history';
import { loadEditRoi } from './roi';
import { loadRealUsage } from './realusage';
import { initAgentSessions } from './agentsessions';
import { showDashboardPanel, showCalibrationPanel, showRoiPanel } from './dashboard';
import { buildPromptIndex, ensurePromptIndex, findHistoricalDuplicate } from './promptindex';

let tracker: BudgetTracker;
let statusBar: vscode.StatusBarItem;
let extContext: vscode.ExtensionContext;

// Per-session memory of context size, keyed by chat session id, to detect the snowball.
const lastContextTokens = new Map<string, number>();

// Per-session memory of prior normalized prompts, to detect duplicate requests.
const sessionPrompts = new Map<string, string[]>();

// Stable session-id resolution + per-session turn counter.
const firstPromptToSession = new Map<string, string>();
const sessionTurnCount = new Map<string, number>();

// Global turn counter, used to periodically refresh history-derived state.
let globalTurnCounter = 0;
function nextGlobalTurn(): number {
    return ++globalTurnCounter;
}

export function activate(context: vscode.ExtensionContext) {
    tracker = new BudgetTracker(context.globalState);
    extContext = context;
    initAgentSessions(context);

    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'tokenguard.showReport';
    context.subscriptions.push(statusBar);
    refreshStatusBar();
    statusBar.show();

    const participant = vscode.chat.createChatParticipant('tokenguard.guard', handler);
    participant.iconPath = new vscode.ThemeIcon('shield');
    context.subscriptions.push(participant);

    // Learn personalized baselines from historical usage (non-blocking).
    void loadCalibration(context.storageUri ?? undefined).then(refreshStatusBar);
    // Index past prompts for cross-session duplicate detection (non-blocking).
    void ensurePromptIndex(context.storageUri ?? undefined);

    context.subscriptions.push(
        vscode.commands.registerCommand('tokenguard.resetSession', () => {
            tracker.resetSession();
            lastContextTokens.clear();
            sessionPrompts.clear();
            sessionTurnCount.clear();
            refreshStatusBar();
            vscode.window.showInformationMessage('TokenGuard: session budget reset.');
        }),
        vscode.commands.registerCommand('tokenguard.showReport', showReport),
        vscode.commands.registerCommand('tokenguard.setBudget', setBudget),
        vscode.commands.registerCommand('tokenguard.showCalibration', showCalibration),
        vscode.commands.registerCommand('tokenguard.showEditRoi', showEditRoi),
        vscode.commands.registerCommand('tokenguard.showDashboard', showDashboard)
    );
}

export function deactivate() {
    lastContextTokens.clear();
}

function refreshStatusBar() {
    const s = tracker.session;
    const sb = tracker.sessionBudget;
    const d = tracker.dailyTokens;
    const db = tracker.dailyBudget;
    const pct = Math.round((s / sb) * 100);
    const icon = pct >= 100 ? '$(error)' : pct >= tracker.warnThreshold * 100 ? '$(warning)' : '$(shield)';
    statusBar.text = `${icon} ${fmt(s)}/${fmt(sb)} · ${fmtUsd(tracker.sessionUsd)} · day ${fmtUsd(tracker.dailyCost)}`;
    statusBar.tooltip = new vscode.MarkdownString(
        `**TokenGuard**\n\n` +
        `Session: ${s.toLocaleString()} / ${sb.toLocaleString()} tokens (${pct}%)\n\n` +
        `Session cost: ${fmtUsd(tracker.sessionUsd)}\n\n` +
        `Today: ${d.toLocaleString()} / ${db.toLocaleString()} tokens · ${fmtUsd(tracker.dailyCost)}\n\n` +
        `Turns this session: ${tracker.turns}\n\n_Click for a full report._`
    );
}

function fmt(n: number): string {
    if (n >= 1000) {
        return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    }
    return String(n);
}

async function handler(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
): Promise<void> {
    const model = request.model;

    // Assemble the text that will be sent: the user's prompt plus any attached context.
    const promptText = request.prompt ?? '';
    const referenceCount = request.references?.length ?? 0;
    const referenceText = await stringifyReferences(request.references);
    const fullInput = `${promptText}\n${referenceText}`;

    // Count tokens accurately using the selected model's tokenizer.
    let contextTokens: number;
    try {
        contextTokens = await model.countTokens(fullInput);
    } catch {
        contextTokens = Math.ceil(fullInput.length / 4); // fallback heuristic
    }

    const sessionId = resolveSessionId(chatContext, promptText);
    const turnIndex = nextTurnIndex(sessionId);
    const prevContextTokens = lastContextTokens.get(sessionId);
    const modelId = model.id ?? model.family ?? 'unknown';
    const modelLabel = (model.name && model.name.trim()) ? model.name : modelId;
    const reasoning = reasoningInfo(modelId);

    // Duplicate detection: compare this prompt against earlier ones this session.
    const dupThreshold = vscode.workspace
        .getConfiguration('tokenguard')
        .get<number>('duplicateSimilarityThreshold', 0.85);
    const priorPrompts = sessionPrompts.get(sessionId) ?? [];
    let duplicateSimilarity = 0;
    for (const p of priorPrompts) {
        duplicateSimilarity = Math.max(duplicateSimilarity, similarity(promptText, p));
    }
    const isDuplicate = duplicateSimilarity >= dupThreshold && promptText.trim().length > 0;

    // Cross-session: is this a near-duplicate of a prompt from an earlier session?
    // Await the one-time index build so it works from the first turn in a new window.
    let historicalDuplicate;
    if (!isDuplicate && promptText.trim().length > 0) {
        try {
            await ensurePromptIndex(extContext?.storageUri ?? undefined);
        } catch {
            // index unavailable; skip historical check
        }
        historicalDuplicate = findHistoricalDuplicate(promptText);
    }

    // Every 25 turns, refresh history-derived state in the background so the live
    // coach stays current without re-scanning on every turn.
    if (nextGlobalTurn() % 25 === 0) {
        void loadCalibration(extContext?.storageUri ?? undefined);
        void buildPromptIndex(extContext?.storageUri ?? undefined);
    }

    // Conservative output projection, inflated for reasoning models whose hidden
    // thinking tokens are billed as output but not exposed in the response text.
    const baseOutput = Math.min(2000, Math.ceil(contextTokens * 0.3));
    const projectedOutput = Math.ceil(baseOutput * reasoning.multiplier);

    // ---- Run the token-economics rules ----
    const ruleInput: RuleInput = {
        promptText,
        referenceCount,
        referencesLookWholeWorkspace: looksLikeWholeWorkspace(request.references),
        modelId,
        contextTokens,
        projectedOutput,
        prevContextTokens,
        isDuplicate,
        duplicateSimilarity,
        historicalDuplicate
    };
    const findings = runRules(ruleInput);

    // ---- Budget check (project input + a conservative output estimate) ----
    const projected = contextTokens + projectedOutput;
    const verdict = tracker.evaluate(projected);

    // ---- Render the coaching panel first ----
    const projectedCost = costUsd(ruleInput.modelId, contextTokens, projectedOutput);
    renderCoaching(stream, contextTokens, projectedOutput, projectedCost, ruleInput.modelId, modelLabel, verdict, findings, reasoning.isReasoning, sessionId, turnIndex);

    // Record this prompt in session history for future duplicate checks.
    priorPrompts.push(promptText);
    sessionPrompts.set(sessionId, priorPrompts);

    // ---- Duplicate short-circuit: skip the model call to save tokens ----
    const blockDuplicates = vscode.workspace
        .getConfiguration('tokenguard')
        .get<boolean>('blockDuplicates', true);
    if (isDuplicate && blockDuplicates) {
        stream.markdown(
            `\n\n♻️ **Skipped to save tokens** — this closely matches an earlier request this session ` +
            `(${Math.round(duplicateSimilarity * 100)}% similar), so TokenGuard did not re-run it and saved ~${fmtUsd(projectedCost)}. ` +
            `Scroll up to reuse the previous answer, rephrase if you need something different, or run ` +
            `\`TokenGuard: Reset Session Budget\` to force a fresh run. ` +
            `(Disable this via \`tokenguard.blockDuplicates\`.)`
        );
        // Record the avoided cost as savings telemetry.
        await logUsage({
            model: ruleInput.modelId,
            operation: 'chat',
            inputTokens: 0,
            outputTokens: 0,
            toolResultTokens: 0,
            costUsd: 0,
            inputCostUsd: 0,
            outputCostUsd: 0,
            durationMs: 0,
            timeToFirstTokenMs: 0,
            finishReason: 'duplicate_skipped',
            toolCallsCount: 0,
            toolNames: [],
            loopIterations: 0,
            loopHitCap: false,
            forcedFinalAnswer: false,
            tokensSavedByCompaction: 0,
            tokensSavedByDuplicate: contextTokens + projectedOutput,
            tokensSavedByTiering: 0,
            sessionId,
            turnIndex,
            workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? '(none)',
            budgetSessionPct: verdict.sessionPct,
            budgetDailyPct: verdict.dailyPct,
            findings: findings.map(f => f.title),
            duplicate: true,
            compacted: false,
            reasoning: reasoning.isReasoning
        });
        return;
    }

    // ---- Hard block path ----
    const hardBlock = vscode.workspace.getConfiguration('tokenguard').get<boolean>('hardBlock', false);
    if (verdict.level === 'over' && hardBlock) {
        stream.markdown(
            `\n\n🛑 **Request blocked** — over budget with hard-block enabled. ` +
            `Reset the session (\`TokenGuard: Reset Session Budget\`), raise the budget, or trim context, then try again.`
        );
        return;
    }

    // ---- Forward to the model (with tools) and stream the answer ----
    stream.markdown('\n\n---\n\n');
    const usage = await runWithTools(request, chatContext, stream, model, fullInput, token);

    // ---- Account for real usage (output inflated for reasoning models) ----
    const totalInput = contextTokens + usage.extraInputTokens;
    const billedOutput = Math.ceil(usage.outputTokens * reasoning.multiplier);
    const actualCost = costUsd(ruleInput.modelId, totalInput, billedOutput);
    await tracker.add(
        totalInput + billedOutput,
        actualCost
    );
    tracker.markTurn();
    lastContextTokens.set(sessionId, contextTokens);
    refreshStatusBar();

    // ---- Emit OpenTelemetry-style usage record for the Observability Hub ----
    const price = priceForModel(ruleInput.modelId).price;
    const suggestion = suggestCheaperModel(ruleInput.modelId, totalInput, billedOutput);
    await logUsage({
        model: ruleInput.modelId,
        operation: 'chat',
        inputTokens: totalInput,
        outputTokens: billedOutput,
        toolResultTokens: usage.extraInputTokens,
        costUsd: actualCost,
        inputCostUsd: (totalInput / 1_000_000) * price.input,
        outputCostUsd: (billedOutput / 1_000_000) * price.output,
        durationMs: usage.durationMs,
        timeToFirstTokenMs: usage.timeToFirstTokenMs,
        finishReason: usage.finishReason,
        toolCallsCount: usage.toolCallsCount,
        toolNames: usage.toolNames,
        loopIterations: usage.loopIterations,
        loopHitCap: usage.loopHitCap,
        forcedFinalAnswer: usage.forcedFinalAnswer,
        tokensSavedByCompaction: usage.tokensSavedByCompaction,
        tokensSavedByDuplicate: 0,
        tokensSavedByTiering: usage.tokensSavedByTiering,
        suggestedCheaperModel: suggestion?.model,
        potentialSavingsUsd: suggestion?.savings,
        sessionId,
        turnIndex,
        workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? '(none)',
        budgetSessionPct: verdict.sessionPct,
        budgetDailyPct: verdict.dailyPct,
        findings: findings.map(f => f.title),
        duplicate: isDuplicate,
        compacted: usage.compacted,
        reasoning: reasoning.isReasoning
    });

    // ---- Closing actual-cost line: reconcile estimate vs reality ----
    // Copilot bills one premium request per user turn regardless of internal tool
    // loops, so credits reflect the model's multiplier — not loop iterations —
    // and only when the model is a known premium-billed model.
    const cm = creditMultiplier(ruleInput.modelId);
    const creditNote = cm.matched && cm.multiplier > 0
        ? ` · ≈ ${cm.multiplier % 1 === 0 ? cm.multiplier : cm.multiplier.toFixed(1)} credit${cm.multiplier === 1 ? '' : 's'} (est.)`
        : '';
    const deltaPct = projectedCost > 0 ? Math.round(((actualCost - projectedCost) / projectedCost) * 100) : 0;
    const deltaNote = deltaPct === 0 ? '' : ` (${deltaPct > 0 ? '+' : ''}${deltaPct}% vs est. ${fmtUsd(projectedCost)})`;
    stream.markdown(
        `\n\n---\n\n🧾 **This turn actually cost:** ${totalInput.toLocaleString()} input + ${billedOutput.toLocaleString()} output = **${fmtUsd(actualCost)}**${creditNote}${deltaNote}` +
        `${usage.extraInputTokens > 0 ? ` · includes ${usage.extraInputTokens.toLocaleString()} tokens of tool-result context` : ''}` +
        `${usage.compacted ? ' · ✂️ context compacted' : ''}`
    );
}

interface ToolUsage {
    outputTokens: number;
    extraInputTokens: number;
    compacted: boolean;
    toolCallsCount: number;
    toolNames: string[];
    loopIterations: number;
    loopHitCap: boolean;
    forcedFinalAnswer: boolean;
    durationMs: number;
    timeToFirstTokenMs: number;
    finishReason: string;
    tokensSavedByCompaction: number;
    tokensSavedByTiering: number;
}

/**
 * Runs the model with the full tool surface available in VS Code and executes a
 * bounded tool-calling loop, so the participant can search/read the workspace
 * just like the built-in agent. The loop cap is itself a token-economics guard.
 */
async function runWithTools(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    model: vscode.LanguageModelChat,
    fullInput: string,
    token: vscode.CancellationToken
): Promise<ToolUsage> {
    const localTools = getLocalTools();
    const externalTools = vscode.lm.tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
    }));
    // Tiered tool loading: always keep TokenGuard's own tools, then add only the
    // external tools most relevant to this prompt, up to a configured budget.
    const maxTools = vscode.workspace.getConfiguration('tokenguard').get<number>('maxToolsPerRequest', 64);
    const relevant = selectRelevantTools(fullInput, externalTools, Math.max(0, maxTools - localTools.length));
    const tools: vscode.LanguageModelChatTool[] = [...localTools, ...relevant];
    // Estimate tokens saved by not shipping the dropped external tool schemas.
    const droppedTools = externalTools.filter(t => !relevant.includes(t));
    const tokensSavedByTiering = Math.ceil(
        droppedTools.reduce((sum, t) => sum + `${t.name} ${t.description ?? ''} ${JSON.stringify(t.inputSchema ?? {})}`.length, 0) / 4
    );

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(no folder open)';
    const today = new Date().toISOString().slice(0, 10);
    const systemPreamble =
        `You are TokenGuard's assistant running inside VS Code. The open workspace root is: ${workspaceRoot}. ` +
        `Today's date is ${today}.\n\n` +
        `You have read-only tools to inspect the workspace:\n` +
        `- tg_find_files(glob): find files by glob, e.g. **/*${today}* or **/*.log — USE THIS FIRST to locate files by name/date instead of guessing paths.\n` +
        `- tg_list_dir(path): list a directory; explore subfolders (e.g. "logs") rather than assuming files live at the root.\n` +
        `- tg_grep(query, isRegex?, glob?): search file contents across the workspace.\n` +
        `- tg_read_file(path): read a file once you have located it.\n\n` +
        `Search strategy — follow this, do NOT give up early:\n` +
        `1. NEVER guess a filename and conclude it is missing. If a guessed path is not found, use tg_find_files or tg_list_dir to discover the real structure.\n` +
        `2. Explore subdirectories (logs/, scripts/, etc.) before concluding something does not exist.\n` +
        `3. When the user asks about "today", glob for the current date (**/*${today}*).\n` +
        `4. Paths are relative to the workspace root. "the folder" means this workspace.\n` +
        `Only conclude you cannot find something after you have actually listed the relevant directories and searched by glob.\n\n` +
        `IMPORTANT — output format: Answer the user's question directly in plain markdown. ` +
        `Do NOT produce any "TokenGuard" status panel, cost/token/credit estimate, budget line, findings list, or "This turn actually cost" receipt. ` +
        `Those are added automatically by the extension around your answer — if you emit them yourself they will appear as confusing duplicates. Never start a line with 🛡️ or 🧾.`;

    const messages: vscode.LanguageModelChatMessage[] = [
        vscode.LanguageModelChatMessage.User(systemPreamble),
        ...historyMessages(chatContext),
        vscode.LanguageModelChatMessage.User(fullInput)
    ];

    const maxIterations = 12; // bounded loop — guards against runaway tool cycles
    let outputText = '';
    let extraInputText = '';
    let compacted = false;
    let compactionCharsSaved = 0;
    let iterations = 0;
    let loopHitCap = false;
    let forcedFinalAnswer = false;
    const toolNames: string[] = [];
    const startTime = Date.now();
    let ttftMs = 0;
    let firstTokenSeen = false;

    try {
        for (let i = 0; i < maxIterations; i++) {
            iterations = i + 1;
            if (token.isCancellationRequested) {
                break;
            }
            // Real compaction: if accumulated history exceeds the context window,
            // summarise older tool results before sending, to defuse the snowball.
            const saved = compactIfNeeded(messages);
            if (saved > 0) {
                compacted = true;
                compactionCharsSaved += saved;
                stream.progress('Compacting context to save tokens…');
            }
            const response = await model.sendRequest(
                messages,
                { tools: tools.length ? tools : undefined },
                token
            );

            const toolCalls: vscode.LanguageModelToolCallPart[] = [];
            for await (const part of response.stream) {
                if (!firstTokenSeen) {
                    firstTokenSeen = true;
                    ttftMs = Date.now() - startTime;
                }
                if (part instanceof vscode.LanguageModelTextPart) {
                    outputText += part.value;
                    stream.markdown(part.value);
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    toolCalls.push(part);
                    toolNames.push(part.name);
                }
            }

            if (toolCalls.length === 0) {
                break; // model produced a final answer
            }
            if (i === maxIterations - 1) {
                loopHitCap = true;
            }

            // Record the assistant turn (its tool-call request) then execute each tool.
            messages.push(vscode.LanguageModelChatMessage.Assistant(toolCalls));
            const resultParts: vscode.LanguageModelToolResultPart[] = [];
            for (const call of toolCalls) {
                stream.progress(`Running \`${call.name}\`…`);
                try {
                    let flat: string;
                    if (isLocalTool(call.name)) {
                        flat = capToolResult(await executeLocalTool(call.name, call.input));
                        extraInputText += flat;
                        resultParts.push(
                            new vscode.LanguageModelToolResultPart(call.callId, [
                                new vscode.LanguageModelTextPart(flat)
                            ])
                        );
                    } else {
                        const result = await vscode.lm.invokeTool(
                            call.name,
                            { input: call.input, toolInvocationToken: request.toolInvocationToken },
                            token
                        );
                        flat = flattenToolResult(result);
                        extraInputText += flat;
                        resultParts.push(
                            new vscode.LanguageModelToolResultPart(call.callId, result.content)
                        );
                    }
                } catch (err) {
                    resultParts.push(
                        new vscode.LanguageModelToolResultPart(call.callId, [
                            new vscode.LanguageModelTextPart(`Tool error: ${String(err)}`)
                        ])
                    );
                }
            }
            messages.push(vscode.LanguageModelChatMessage.User(resultParts));
        }

        // If the loop ended (cap reached or cancellation) without a written
        // answer, make one final tool-free call so the model must produce text
        // from the context it has already gathered.
        if (!outputText.trim() && !token.isCancellationRequested) {
            forcedFinalAnswer = true;
            messages.push(
                vscode.LanguageModelChatMessage.User(
                    'Now answer the original question directly using the information you have gathered. Do not call any more tools.'
                )
            );
            const finalResponse = await model.sendRequest(messages, {}, token);
            for await (const part of finalResponse.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    outputText += part.value;
                    stream.markdown(part.value);
                }
            }
        }
    } catch (err) {
        stream.markdown(`\n\n⚠️ TokenGuard could not complete the model request: ${String(err)}`);
    }

    if (!outputText.trim()) {
        stream.markdown(
            `\n\n⚠️ The model gathered data but did not produce an answer within ${maxIterations} tool steps. ` +
            `Try narrowing the question, or raise \`tokenguard\` loop limits.`
        );
    }

    let outputTokens: number;
    let extraInputTokens: number;
    try {
        outputTokens = await model.countTokens(outputText);
        extraInputTokens = extraInputText ? await model.countTokens(extraInputText) : 0;
    } catch {
        outputTokens = Math.ceil(outputText.length / 4);
        extraInputTokens = Math.ceil(extraInputText.length / 4);
    }
    const finishReason = loopHitCap ? 'length' : toolNames.length > 0 ? 'tool_calls_then_stop' : 'stop';
    return {
        outputTokens,
        extraInputTokens,
        compacted,
        toolCallsCount: toolNames.length,
        toolNames,
        loopIterations: iterations,
        loopHitCap,
        forcedFinalAnswer,
        durationMs: Date.now() - startTime,
        timeToFirstTokenMs: ttftMs,
        finishReason,
        tokensSavedByCompaction: Math.ceil(compactionCharsSaved / 4),
        tokensSavedByTiering
    };
}

/**
 * Tiered tool loading — rank external tools by keyword overlap with the prompt
 * and keep only the most relevant, so we don't ship every schema every call.
 */
function selectRelevantTools(
    promptText: string,
    external: vscode.LanguageModelChatTool[],
    budget: number
): vscode.LanguageModelChatTool[] {
    if (budget <= 0 || external.length === 0) {
        return [];
    }
    if (external.length <= budget) {
        return external;
    }
    const words = new Set(
        promptText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
    );
    const scored = external.map(t => {
        const hay = `${t.name} ${t.description ?? ''}`.toLowerCase();
        let score = 0;
        for (const w of words) {
            if (hay.includes(w)) {
                score++;
            }
        }
        return { tool: t, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, budget).map(s => s.tool);
}

/**
 * Real compaction — when the running message history exceeds the configured
 * context window, replace the text of older tool-result parts with a short head,
 * keeping the most recent results full. Preserves tool-call/result pairing.
 * Returns the number of characters removed (0 if nothing was compacted).
 */
function compactIfNeeded(messages: vscode.LanguageModelChatMessage[]): number {
    const cfg = vscode.workspace.getConfiguration('tokenguard');
    if (!cfg.get<boolean>('enableCompaction', true)) {
        return 0;
    }
    const maxChars = cfg.get<number>('maxContextWindowTokens', 24000) * 4; // ~4 chars/token
    const keepRecent = 2; // keep the last N tool-result messages full

    let totalChars = 0;
    const toolResultIdx: number[] = [];
    for (let i = 0; i < messages.length; i++) {
        const content = messages[i].content;
        if (Array.isArray(content)) {
            for (const part of content) {
                if (part instanceof vscode.LanguageModelToolResultPart) {
                    toolResultIdx.push(i);
                    break;
                }
            }
            for (const part of content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    totalChars += part.value.length;
                } else if (part instanceof vscode.LanguageModelToolResultPart) {
                    for (const p of part.content) {
                        if (p instanceof vscode.LanguageModelTextPart) {
                            totalChars += p.value.length;
                        }
                    }
                }
            }
        }
    }

    if (totalChars <= maxChars) {
        return 0;
    }

    const compactIdx = toolResultIdx.slice(0, Math.max(0, toolResultIdx.length - keepRecent));
    if (compactIdx.length === 0) {
        return 0;
    }

    let charsSaved = 0;
    for (const i of compactIdx) {
        const content = messages[i].content;
        if (!Array.isArray(content)) {
            continue;
        }
        const newParts = content.map(part => {
            if (part instanceof vscode.LanguageModelToolResultPart) {
                let text = '';
                for (const p of part.content) {
                    if (p instanceof vscode.LanguageModelTextPart) {
                        text += p.value;
                    }
                }
                if (text.length > 500) {
                    charsSaved += text.length - 400;
                    const head = text.slice(0, 400);
                    return new vscode.LanguageModelToolResultPart(part.callId, [
                        new vscode.LanguageModelTextPart(
                            `${head}\n…[compacted by TokenGuard: ${(text.length - 400).toLocaleString()} chars summarised away]`
                        )
                    ]);
                }
                return part;
            }
            return part;
        });
        messages[i] = vscode.LanguageModelChatMessage.User(newParts as any);
    }
    return charsSaved;
}

/** Convert prior chat turns into model messages so the participant keeps context. */
function historyMessages(chatContext: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
    const msgs: vscode.LanguageModelChatMessage[] = [];
    for (const turn of chatContext.history) {
        if (turn instanceof vscode.ChatRequestTurn) {
            msgs.push(vscode.LanguageModelChatMessage.User(turn.prompt));
        } else if (turn instanceof vscode.ChatResponseTurn) {
            let text = '';
            for (const part of turn.response) {
                if (part instanceof vscode.ChatResponseMarkdownPart) {
                    text += part.value.value;
                }
            }
            const cleaned = stripTokenGuardChrome(text);
            if (cleaned.trim()) {
                msgs.push(vscode.LanguageModelChatMessage.Assistant(cleaned));
            }
        }
    }
    return msgs;
}

/**
 * Remove TokenGuard's own UI (coaching panel, findings, receipt) from a prior
 * assistant turn so the model sees only the real answer — and never learns to
 * imitate the panel format in its own output.
 */
function stripTokenGuardChrome(text: string): string {
    let t = text;
    // Drop the leading coaching panel up to and including its divider.
    t = t.replace(/###\s*🛡️\s*TokenGuard[\s\S]*?\n---\n/g, '');
    // Drop receipt and skip/duplicate notice lines.
    t = t.replace(/^.*🧾.*$/gm, '');
    t = t.replace(/^.*♻️\s*\*\*Skipped.*$/gm, '');
    // Drop stray divider-only lines left behind.
    t = t.replace(/\n---\s*\n/g, '\n');
    return t.trim();
}

/** Flatten a tool result's content into plain text for token accounting. */
function flattenToolResult(result: vscode.LanguageModelToolResult): string {
    let text = '';
    for (const part of result.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
            text += part.value;
        }
    }
    return text;
}

/** Cap a tool result's size before feeding it back, to curb the context snowball. */
function capToolResult(text: string): string {
    const cap = vscode.workspace.getConfiguration('tokenguard').get<number>('maxToolResultChars', 8000);
    if (text.length <= cap) {
        return text;
    }
    return text.slice(0, cap) + `\n…[truncated by TokenGuard: ${(text.length - cap).toLocaleString()} chars omitted to save tokens]`;
}

function renderCoaching(
    stream: vscode.ChatResponseStream,
    inputTokens: number,
    projectedOutput: number,
    projectedCost: number,
    modelId: string,
    modelLabel: string,
    verdict: ReturnType<BudgetTracker['evaluate']>,
    findings: ReturnType<typeof runRules>,
    isReasoning: boolean,
    sessionId: string,
    turnIndex: number
) {
    const badge = verdict.level === 'over' ? '🛑' : verdict.level === 'warn' ? '⚠️' : '🛡️';
    const { matched } = priceForModel(modelId);
    const reasoningNote = isReasoning ? ' · 🧠 _reasoning model — output inflated for hidden thinking tokens_' : '';
    const priceNote = matched ? '' : ' _(default price — add this model to `tokenguard.modelPrices`)_';
    const cm = creditMultiplier(modelId);
    const creditNote = cm.matched && cm.multiplier > 0
        ? ` · ≈ ${cm.multiplier % 1 === 0 ? cm.multiplier : cm.multiplier.toFixed(2)} Copilot credit${cm.multiplier === 1 ? '' : 's'}/request (est.)`
        : '';
    stream.markdown(`### ${badge} TokenGuard · _turn ${turnIndex} · session ${sessionId}_\n`);
    stream.markdown(
        `**This request:** ~${inputTokens.toLocaleString()} input + ~${projectedOutput.toLocaleString()} projected output tokens ≈ **${fmtUsd(projectedCost)}** on \`${modelLabel}\`${priceNote}${reasoningNote}${creditNote}\n\n` +
        `**Session:** ${Math.round(verdict.sessionPct * 100)}% of budget · ${fmtUsd(tracker.sessionUsd)} · **Today:** ${Math.round(verdict.dailyPct * 100)}% · ${fmtUsd(tracker.dailyCost)}\n`
    );
    if (verdict.message) {
        stream.markdown(`\n${verdict.level === 'over' ? '🛑' : '⚠️'} ${verdict.message}\n`);
    }
    if (findings.length > 0) {
        stream.markdown(`\n**${findings.length} token-economics issue${findings.length > 1 ? 's' : ''} flagged:**\n`);
        for (const f of findings) {
            stream.markdown(`\n- ${f.icon} **${f.title}** — ${f.detail}`);
        }
    } else {
        stream.markdown(`\n✅ No token-economics issues detected.`);
    }
}

async function stringifyReferences(refs: readonly vscode.ChatPromptReference[] | undefined): Promise<string> {
    if (!refs || refs.length === 0) {
        return '';
    }
    const parts: string[] = [];
    for (const r of refs) {
        const v = r.value;
        if (typeof v === 'string') {
            parts.push(v);
        } else if (v instanceof vscode.Uri) {
            try {
                const bytes = await vscode.workspace.fs.readFile(v);
                parts.push(new TextDecoder('utf-8').decode(bytes));
            } catch {
                parts.push(v.toString());
            }
        } else if (v instanceof vscode.Location) {
            try {
                const doc = await vscode.workspace.openTextDocument(v.uri);
                parts.push(doc.getText(v.range));
            } catch {
                parts.push(v.uri.toString());
            }
        }
    }
    return parts.join('\n');
}

function looksLikeWholeWorkspace(refs: readonly vscode.ChatPromptReference[] | undefined): boolean {
    if (!refs) {
        return false;
    }
    return refs.some(r => {
        const id = (r.id ?? '').toLowerCase();
        return id.includes('workspace') || id.includes('codebase');
    });
}

function getSessionId(chatContext: vscode.ChatContext): string {
    // Use the length + first turn as a cheap stable-ish session key.
    const first = chatContext.history[0];
    if (first && 'prompt' in first) {
        return `s:${(first as vscode.ChatRequestTurn).prompt.slice(0, 24)}`;
    }
    return 'session';
}

/**
 * Resolve a stable session id. The first user turn in a chat anchors the
 * session; subsequent turns map back to the same id via that first prompt.
 */
function resolveSessionId(chatContext: vscode.ChatContext, currentPrompt: string): string {
    const firstTurn = chatContext.history.find(t => t instanceof vscode.ChatRequestTurn) as
        | vscode.ChatRequestTurn
        | undefined;
    const anchor = firstTurn ? firstTurn.prompt : currentPrompt;
    const key = anchor.slice(0, 80);
    let id = firstPromptToSession.get(key);
    if (!id) {
        id = `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        firstPromptToSession.set(key, id);
    }
    return id;
}

/** Increment and return the turn number for a session (1-based). */
function nextTurnIndex(sessionId: string): number {
    const n = (sessionTurnCount.get(sessionId) ?? 0) + 1;
    sessionTurnCount.set(sessionId, n);
    return n;
}

/** Token-overlap (Jaccard) similarity between two prompts, 0..1. */
function similarity(a: string, b: string): number {
    const norm = (s: string) =>
        new Set(
            s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1)
        );
    const sa = norm(a);
    const sb = norm(b);
    if (sa.size === 0 || sb.size === 0) {
        return 0;
    }
    let inter = 0;
    for (const w of sa) {
        if (sb.has(w)) {
            inter++;
        }
    }
    const union = sa.size + sb.size - inter;
    return union === 0 ? 0 : inter / union;
}

function showReport() {
    const s = tracker.session;
    const sb = tracker.sessionBudget;
    const d = tracker.dailyTokens;
    const db = tracker.dailyBudget;
    vscode.window.showInformationMessage(
        `TokenGuard — Session ${s.toLocaleString()}/${sb.toLocaleString()} tokens · ${fmtUsd(tracker.sessionUsd)} (${tracker.turns} turns) · ` +
        `Today ${d.toLocaleString()}/${db.toLocaleString()} · ${fmtUsd(tracker.dailyCost)}`,
        'Reset Session',
        'Set Budgets'
    ).then(choice => {
        if (choice === 'Reset Session') {
            vscode.commands.executeCommand('tokenguard.resetSession');
        } else if (choice === 'Set Budgets') {
            vscode.commands.executeCommand('tokenguard.setBudget');
        }
    });
}

async function setBudget() {
    const cfg = vscode.workspace.getConfiguration('tokenguard');
    const session = await vscode.window.showInputBox({
        prompt: 'Session token budget',
        value: String(cfg.get<number>('sessionBudget', 50000)),
        validateInput: v => (/^\d+$/.test(v) ? undefined : 'Enter a whole number')
    });
    if (session === undefined) {
        return;
    }
    const daily = await vscode.window.showInputBox({
        prompt: 'Daily token budget',
        value: String(cfg.get<number>('dailyBudget', 500000)),
        validateInput: v => (/^\d+$/.test(v) ? undefined : 'Enter a whole number')
    });
    if (daily === undefined) {
        return;
    }
    await cfg.update('sessionBudget', Number(session), vscode.ConfigurationTarget.Global);
    await cfg.update('dailyBudget', Number(daily), vscode.ConfigurationTarget.Global);
    refreshStatusBar();
    vscode.window.showInformationMessage('TokenGuard budgets updated.');
}

async function showCalibration() {
    const cal = await loadCalibration(extContext?.storageUri ?? undefined);
    showCalibrationPanel(cal);
}

async function showEditRoi() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    await loadCalibration(extContext?.storageUri ?? undefined); // real per-model cost for attribution
    const r = await loadEditRoi(extContext?.storageUri ?? undefined, root);
    showRoiPanel(r);
}

async function showDashboard() {
    const pick = await vscode.window.showQuickPick(
        [
            { label: 'All workspaces', scope: 'all' as const },
            { label: 'This workspace', scope: 'workspace' as const }
        ],
        { placeHolder: 'Build usage dashboard for…' }
    );
    if (!pick) {
        return;
    }
    const u = await loadRealUsage(extContext?.storageUri ?? undefined, pick.scope);
    showDashboardPanel(u);
}
