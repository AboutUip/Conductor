/** 独立维护一个周期任务组的间隔和下一次截止时间。 */
export interface ScheduledIntervalGroup {
    groupId: number;
    intervalMs: number;
    dueAt: number;
}

/** 按稳定组 ID 跟踪截止时间，允许相同周期的任务拥有不同相位。 */
export class ScheduleGroupMap {
    #groups: Map<number, ScheduledIntervalGroup> = new Map();

    get size(): number {
        return this.#groups.size;
    }

    add(groupId: number, intervalMs: number, dueAt: number): void {
        this.#groups.set(groupId, { groupId, intervalMs, dueAt });
    }

    delete(groupId: number): boolean {
        return this.#groups.delete(groupId);
    }

    intervals(): number[] {
        return [...this.#groups.values()].map((group) => group.intervalMs);
    }

    nextDueAt(): number {
        let nextDueAt = Infinity;
        this.#groups.forEach((group) => {
            nextDueAt = Math.min(nextDueAt, group.dueAt);
        });
        return nextDueAt;
    }

    /** 推进到未来的截止时间，并返回本轮到期的组；过期周期合并为一次派发。 */
    advanceDue(now: number): number[] {
        const dueGroups: number[] = [];
        this.#groups.forEach((group) => {
            if (group.dueAt > now) return;

            const missedPeriods = Math.floor((now - group.dueAt) / group.intervalMs);
            group.dueAt += (missedPeriods + 1) * group.intervalMs;
            dueGroups.push(group.groupId);
        });
        return dueGroups;
    }
}
