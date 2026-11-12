import type { IntervalId } from './task-types.js';

/** 保存间隔与标识的映射，并为每个间隔累计经过的时间。 */
export class IntervalAccumulatorMap extends Map<number, IntervalId> {
    // 累计值实现
    #elapsedByIntervalMs: Map<number, number> = new Map();

    // 差值Map实现
    #differenceValue: Map<number, number> = new Map();

    /** 用可选的初始键值对创建累计映射。 */
    constructor(entries?: Iterable<readonly [number, IntervalId]> | null) {
        super(entries);
    }

    /** 写入间隔及其标识，并初始化该间隔的累计时间。 */
    setWithElapsedTime(intervalMs: number, intervalId: IntervalId): void {
        super.set(intervalMs, intervalId);
        this.#elapsedByIntervalMs.set(intervalMs, 0);
    }

    /** 写入间隔及其标识，并初始化该间隔的原始时间。 */
    setWithOriginalTime(intervalMs: number, intervalId: IntervalId): void {
        super.set(intervalMs, intervalId);
        this.#differenceValue.set(intervalMs, intervalMs);
    }

    /** 删除间隔映射及其累计/差值时间。 */
    deleteWithTotalTime(intervalMs: number): boolean {
        super.delete(intervalMs);
        this.#elapsedByIntervalMs.delete(intervalMs);
        this.#differenceValue.delete(intervalMs);
        return true;
    }

    /**
     * 为所有间隔累加一个 tick，并返回本次到期的间隔。
     * @param tickIntervalMs 本次经过的 tick 毫秒数。
     */
    advanceElapsedTime(tickIntervalMs: number): number[] {
        const dueIntervals: number[] = [];
        this.#elapsedByIntervalMs.forEach((elapsedMs, intervalMs, elapsedByInterval) => {
            const updatedElapsedMs: number = elapsedMs + tickIntervalMs;
            if (updatedElapsedMs === intervalMs) {
                dueIntervals.push(intervalMs);
                elapsedByInterval.set(intervalMs, 0);
            } else {
                elapsedByInterval.set(intervalMs, updatedElapsedMs);
            }
        });
        return dueIntervals;
    }

    /**
     * 获得下一次执行的最小超时时间
     */
    getMinDiffTime(): number{
        return Math.min(...Array.from(this.#differenceValue.values()));
    }

    /**
     * 为所有差值进行计算下一次tick,返回应该执行Array<Task>的毫秒Delay
     */
    advanceOriginalTime(minDelay: number): number[] {
        const dueIntervals: number[] = [];
        this.#differenceValue.forEach((differenceMs, intervalMs, differenceValue) => {
            const updatedElapsedMs: number = differenceMs - minDelay;
            if (updatedElapsedMs === 0){
                dueIntervals.push(intervalMs);
                differenceValue.set(intervalMs, intervalMs);
            }else{
                differenceValue.set(intervalMs, updatedElapsedMs);
            }
        });
        return dueIntervals;
    }

    /** 将所有间隔的累计时间重置为零。
     *  服务于累计算法
     */
    resetElapsedTime(): void {
        this.#elapsedByIntervalMs.forEach((_elapsedMs, intervalMs, elapsedByInterval) => {
            elapsedByInterval.set(intervalMs, 0);
        });
    }
}