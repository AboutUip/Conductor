import { greatestCommonDivisor } from '../utils/greatest-common-divisor.js';
import { ScheduleGroupMap } from '../structures/schedule-group-map.js';
import type { SchedulingStrategy } from './scheduling-strategy.js';

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;

/** 用最大公约数 tick 轮询单调时钟截止时间的策略。 */
export class LeastCommonMultipleStrategy implements SchedulingStrategy {
    #baseIntervalMs: number;
    #tickIntervalMs: number;
    #tickTimer: ReturnType<typeof setTimeout> | undefined;
    #groups: ScheduleGroupMap = new ScheduleGroupMap();
    #isPaused = true;
    #isDispatching = false;
    #clockOffsetMs = 0;
    #pausedAt = performance.now();
    #dispatchGroup: (groupId: number) => void;

    #onTick = (): void => {
        this.#tickTimer = undefined;
        this.flushDue();
        this.#reschedule();
    };

    constructor(
        baseIntervalMs: number,
        dispatchGroup: (groupId: number) => void
    ) {
        this.#baseIntervalMs = baseIntervalMs;
        this.#tickIntervalMs = baseIntervalMs;
        this.#dispatchGroup = dispatchGroup;
    }

    get defaultIntervalMs(): number {
        return this.#tickIntervalMs;
    }

    addGroup(groupId: number, intervalMs: number): void {
        this.#groups.add(groupId, intervalMs, this.#now() + intervalMs);
        this.#reschedule();
    }

    removeGroups(groupIds: readonly number[]): void {
        groupIds.forEach((groupId) => this.#groups.delete(groupId));
        this.#reschedule();
    }

    flushDue(): void {
        if (!this.#isPaused) this.#dispatchDue();
    }

    pause(): void {
        if (this.#isPaused) return;
        this.#dispatchDue();
        this.#pausedAt = this.#now();
        this.#isPaused = true;
        this.#clearTimer();
    }

    resume(): void {
        if (!this.#isPaused) return;
        this.#clockOffsetMs = performance.now() - this.#pausedAt;
        this.#isPaused = false;
        this.#reschedule();
    }

    kill(): void {
        this.pause();
    }

    #now(): number {
        return this.#isPaused
            ? this.#pausedAt
            : performance.now() - this.#clockOffsetMs;
    }

    #dispatchDue(): void {
        if (this.#isDispatching) return;
        this.#isDispatching = true;
        try {
            this.#groups.advanceDue(this.#now())
                .forEach((groupId) => this.#dispatchGroup(groupId));
        } finally {
            this.#isDispatching = false;
        }
    }

    #clearTimer(): void {
        if (this.#tickTimer === undefined) return;
        clearTimeout(this.#tickTimer);
        this.#tickTimer = undefined;
    }

    #reschedule(): void {
        this.#clearTimer();
        this.#tickIntervalMs = this.#groups.size === 0
            ? this.#baseIntervalMs
            : greatestCommonDivisor(this.#baseIntervalMs, ...this.#groups.intervals());
        if (!this.#isPaused && this.#groups.size > 0) {
            const timeUntilNextDue = this.#groups.nextDueAt() - this.#now();
            const delayMs = Math.max(
                1,
                Math.ceil(Math.min(
                    MAX_TIMEOUT_DELAY_MS,
                    this.#tickIntervalMs,
                    timeUntilNextDue
                ))
            );
            this.#tickTimer = setTimeout(this.#onTick, delayMs);
        }
    }
}
