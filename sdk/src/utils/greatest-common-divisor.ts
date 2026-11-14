/** 计算安全整数的最大公约数。 */
export function greatestCommonDivisor(firstValue: number, ...remainingValues: number[]): number {
    const values = [firstValue, ...remainingValues];
    if (!values.every(Number.isSafeInteger)) {
        throw new RangeError('Arguments must be safe integers');
    }

    let divisor = Math.abs(firstValue);
    for (const value of remainingValues) {
        let left = divisor;
        let right = Math.abs(value);
        while (right !== 0) {
            [left, right] = [right, left % right];
        }
        divisor = left;
    }
    return divisor;
}
