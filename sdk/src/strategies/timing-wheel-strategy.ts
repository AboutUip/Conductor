import { ScheduleGroupMap } from '../structures/schedule-group-map.js';
import type { SchedulingStrategy } from './scheduling-strategy.js';

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/** 用单个一次性计时器推进独立截止时间组的策略。 */
export class TimingWheelStrategy implements SchedulingStrategy {
    #tickTimer: ReturnType<typeof setTimeout> | undefined;
    #groups: ScheduleGroupMap = new ScheduleGroupMap();
    #isPaused = true;
    #isAdvancing = false;
    #clockOffsetMs = 0;
    #pausedAt = performance.now();
    #dispatchGroup: (groupId: number) => void;
    #defaultIntervalMs: number;

    #onTick = (): void => {
        this.#tickTimer = undefined;
        if (this.#isPaused) return;
        this.#advance();
        this.#schedule();
    };

    constructor(
        baseIntervalMs: number,
        dispatchGroup: (groupId: number) => void
    ) {
        this.#defaultIntervalMs = baseIntervalMs;
        this.#dispatchGroup = dispatchGroup;
    }

    get defaultIntervalMs(): number {
        return this.#defaultIntervalMs;
    }

    addGroup(groupId: number, intervalMs: number): void {
        this.#groups.add(groupId, intervalMs, this.#now() + intervalMs);
        if (!this.#isPaused) this.#reschedule();
    }

    removeGroups(groupIds: readonly number[]): void {
        groupIds.forEach((groupId) => this.#groups.delete(groupId));
        if (!this.#isPaused) this.#reschedule();
    }

    flushDue(): void {
        if (this.#isPaused) return;
        this.#advance();
        this.#reschedule();
    }

    pause(): void {
        if (this.#isPaused) return;
        this.#advance();
        this.#pausedAt = this.#now();
        this.#isPaused = true;
        this.#clearTimer();
    }

    resume(): void {
        if (!this.#isPaused) return;
        this.#clockOffsetMs = performance.now() - this.#pausedAt;
        this.#isPaused = false;
        this.#schedule();
    }

    kill(): void {
        this.pause();
    }

    #now(): number {
        return this.#isPaused
            ? this.#pausedAt
            : performance.now() - this.#clockOffsetMs;
    }

    #advance(): void {
        if (this.#isAdvancing) return;
        this.#isAdvancing = true;
        try {
            this.#groups.advanceDue(this.#now())
                .forEach((groupId) => this.#dispatchGroup(groupId));
        } finally {
            this.#isAdvancing = false;
        }
    }

    #schedule(): void {
        if (this.#isPaused || this.#tickTimer !== undefined) return;
        const nextDueAt = this.#groups.nextDueAt();
        if (!Number.isFinite(nextDueAt)) return;

        const delay = Math.min(
            MAX_TIMEOUT_DELAY_MS,
            Math.max(0, nextDueAt - this.#now())
        );
        this.#tickTimer = setTimeout(this.#onTick, delay);
    }

    #clearTimer(): void {
        if (this.#tickTimer === undefined) return;
        clearTimeout(this.#tickTimer);
        this.#tickTimer = undefined;
    }

    #reschedule(): void {
        this.#clearTimer();
        this.#schedule();
    }
}
