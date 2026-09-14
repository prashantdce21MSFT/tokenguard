import * as vscode from 'vscode';

/** Keys used in globalState for persistence. */
const DAILY_KEY = 'tokenguard.daily';

interface DailyRecord {
    date: string; // YYYY-MM-DD (local)
    tokens: number;
    cost: number;
}

/**
 * Tracks token consumption for the current session (in-memory) and the
 * current calendar day (persisted in globalState so it survives reloads).
 */
export class BudgetTracker {
    private sessionTokens = 0;
    private sessionCost = 0;
    private sessionTurns = 0;

    constructor(private readonly memento: vscode.Memento) {}

    private today(): string {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    private readDaily(): DailyRecord {
        const rec = this.memento.get<DailyRecord>(DAILY_KEY);
        if (!rec || rec.date !== this.today()) {
            return { date: this.today(), tokens: 0, cost: 0 };
        }
        // Backfill cost for records written by an older version.
        if (rec.cost === undefined) {
            rec.cost = 0;
        }
        return rec;
    }

    get dailyTokens(): number {
        return this.readDaily().tokens;
    }

    get dailyCost(): number {
        return this.readDaily().cost;
    }

    get session(): number {
        return this.sessionTokens;
    }

    get sessionUsd(): number {
        return this.sessionCost;
    }

    get turns(): number {
        return this.sessionTurns;
    }

    /** Record consumed tokens (and their USD cost) against session and daily counters. */
    async add(tokens: number, cost = 0): Promise<void> {
        this.sessionTokens += tokens;
        this.sessionCost += cost;
        const rec = this.readDaily();
        rec.tokens += tokens;
        rec.cost += cost;
        await this.memento.update(DAILY_KEY, rec);
    }

    markTurn(): void {
        this.sessionTurns += 1;
    }

    resetSession(): void {
        this.sessionTokens = 0;
        this.sessionCost = 0;
        this.sessionTurns = 0;
    }

    private cfg() {
        return vscode.workspace.getConfiguration('tokenguard');
    }

    get sessionBudget(): number {
        return this.cfg().get<number>('sessionBudget', 50000);
    }

    get dailyBudget(): number {
        return this.cfg().get<number>('dailyBudget', 500000);
    }

    get warnThreshold(): number {
        return this.cfg().get<number>('warnThresholdPercent', 80) / 100;
    }

    /**
     * Given the tokens a request is *about* to cost, decide whether it is
     * within budget, in the warning zone, or over budget.
     */
    evaluate(projected: number): {
        level: 'ok' | 'warn' | 'over';
        sessionPct: number;
        dailyPct: number;
        message?: string;
    } {
        const sessAfter = this.sessionTokens + projected;
        const dayAfter = this.dailyTokens + projected;
        const sessionPct = sessAfter / this.sessionBudget;
        const dailyPct = dayAfter / this.dailyBudget;

        if (sessionPct >= 1 || dailyPct >= 1) {
            const which = sessionPct >= 1 ? 'session' : 'daily';
            return {
                level: 'over',
                sessionPct,
                dailyPct,
                message: `This request would push you over your **${which}** token budget.`
            };
        }
        if (sessionPct >= this.warnThreshold || dailyPct >= this.warnThreshold) {
            const which = sessionPct >= this.warnThreshold ? 'session' : 'daily';
            return {
                level: 'warn',
                sessionPct,
                dailyPct,
                message: `You are approaching your **${which}** token budget.`
            };
        }
        return { level: 'ok', sessionPct, dailyPct };
    }
}
