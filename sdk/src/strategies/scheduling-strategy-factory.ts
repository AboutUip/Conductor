import { LeastCommonMultipleStrategy } from './least-common-multiple-strategy.js';
import { DeadlineStrategy } from './deadline-strategy.js';
import { TimingWheelStrategy } from './timing-wheel-strategy.js';
import type { SchedulingStrategy } from './scheduling-strategy.js';
import { SchedulingType } from '../types/task-types.js';

/** 根据公开调度模式创建对应策略。 */
export function createSchedulingStrategy(
    schedulingType: SchedulingType,
    baseIntervalMs: number,
    dispatchGroup: (groupId: number) => void
): SchedulingStrategy {
    switch (schedulingType) {
        case SchedulingType.LeastCommonMultiple:
            return new LeastCommonMultipleStrategy(baseIntervalMs, dispatchGroup);
        case SchedulingType.TimingWheel:
            return new TimingWheelStrategy(baseIntervalMs, dispatchGroup);
        case SchedulingType.Deadline:
            return new DeadlineStrategy(baseIntervalMs, dispatchGroup);
        default:
            throw new RangeError(`Unsupported scheduling type: ${schedulingType}`);
    }
}
