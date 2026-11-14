/** 单个已注册周期在单调时钟时间轴上的下一次绝对派发截止时间。 */
export interface IntervalDeadline {
    groupId: number;
    intervalMs: number;
    dueAt: number;
}

/**
 * 按最早截止时间排序的最小堆。
 * 通过调度组索引支持 O(log n) 插入、更新和删除；读取最早截止时间为 O(1)。
 */
export class DeadlineHeap {
    #items: IntervalDeadline[] = [];
    #indexByGroupId: Map<number, number> = new Map();

    get size(): number {
        return this.#items.length;
    }

    peek(): IntervalDeadline | undefined {
        return this.#items[0];
    }

    set(groupId: number, intervalMs: number, dueAt: number): void {
        const existingIndex = this.#indexByGroupId.get(groupId);
        if (existingIndex !== undefined) {
            this.#items[existingIndex].intervalMs = intervalMs;
            this.#items[existingIndex].dueAt = dueAt;
            this.#restoreHeap(existingIndex);
            return;
        }

        const index = this.#items.length;
        this.#items.push({ groupId, intervalMs, dueAt });
        this.#indexByGroupId.set(groupId, index);
        this.#moveUp(index);
    }

    delete(groupId: number): boolean {
        const index = this.#indexByGroupId.get(groupId);
        if (index === undefined) return false;

        const lastIndex = this.#items.length - 1;
        const lastItem = this.#items[lastIndex];
        this.#items.pop();
        this.#indexByGroupId.delete(groupId);

        if (index < this.#items.length) {
            this.#items[index] = lastItem;
            this.#indexByGroupId.set(lastItem.groupId, index);
            this.#restoreHeap(index);
        }
        return true;
    }

    pop(): IntervalDeadline | undefined {
        const firstItem = this.peek();
        if (firstItem !== undefined) this.delete(firstItem.groupId);
        return firstItem;
    }

    #restoreHeap(index: number): void {
        const parentIndex = Math.floor((index - 1) / 2);
        if (index > 0 && this.#isBefore(this.#items[index], this.#items[parentIndex])) {
            this.#moveUp(index);
        } else {
            this.#moveDown(index);
        }
    }

    #moveUp(startIndex: number): void {
        let index = startIndex;
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            if (!this.#isBefore(this.#items[index], this.#items[parentIndex])) break;
            this.#swap(index, parentIndex);
            index = parentIndex;
        }
    }

    #moveDown(startIndex: number): void {
        let index = startIndex;
        while (true) {
            const leftIndex = index * 2 + 1;
            const rightIndex = leftIndex + 1;
            let firstIndex = index;

            if (
                leftIndex < this.#items.length
                && this.#isBefore(this.#items[leftIndex], this.#items[firstIndex])
            ) {
                firstIndex = leftIndex;
            }
            if (
                rightIndex < this.#items.length
                && this.#isBefore(this.#items[rightIndex], this.#items[firstIndex])
            ) {
                firstIndex = rightIndex;
            }
            if (firstIndex === index) return;

            this.#swap(index, firstIndex);
            index = firstIndex;
        }
    }

    #swap(firstIndex: number, secondIndex: number): void {
        const firstItem = this.#items[firstIndex];
        const secondItem = this.#items[secondIndex];
        this.#items[firstIndex] = secondItem;
        this.#items[secondIndex] = firstItem;
        this.#indexByGroupId.set(firstItem.groupId, secondIndex);
        this.#indexByGroupId.set(secondItem.groupId, firstIndex);
    }

    #isBefore(first: IntervalDeadline, second: IntervalDeadline): boolean {
        return first.dueAt < second.dueAt
            || (
                first.dueAt === second.dueAt
                && (
                    first.intervalMs < second.intervalMs
                    || (first.intervalMs === second.intervalMs && first.groupId < second.groupId)
                )
            );
    }
}
