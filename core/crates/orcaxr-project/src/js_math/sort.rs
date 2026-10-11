//! `Array.prototype.sort(comparefn)` exactly as V8 runs it: its TimSort
//! (`third_party/v8/builtins/array-sort.tq`) — natural runs, binary insertion
//! up to the minimum run, the pending-run stack's merge rules and galloping
//! merges. A consistent comparator sorts the same in any stable sort, but the
//! browser's comparators are not all consistent (a tolerance makes ties
//! intransitive), and then only the same algorithm visits the same pairs and
//! leaves the same order. `js-math-vectors.json` pins it against V8.
use std::cmp::Ordering;

/// Wins in a row that switch a merge to galloping (`kMinGallopWins`).
const MIN_GALLOP: usize = 7;

/// Sorts `items` as V8 sorts an array with `compare`, which answers like a
/// comparefn: below zero when its first argument sorts first, NaN as zero.
pub fn sort_by<T: Clone>(items: &mut [T], mut compare: impl FnMut(&T, &T) -> f64) {
    let length = items.len();
    if length < 2 {
        return;
    }
    let mut state = State {
        compare: &mut compare,
        min_gallop: MIN_GALLOP,
        runs: Vec::new(),
    };
    let min_run = min_run_length(length);
    let mut low = 0;
    let mut remaining = length;
    while remaining != 0 {
        let mut run = state.count_and_make_run(items, low, low + remaining);
        if run < min_run {
            let forced = min_run.min(remaining);
            state.binary_insertion_sort(items, low, low + run, low + forced);
            run = forced;
        }
        state.runs.push((low, run));
        state.merge_collapse(items);
        low += run;
        remaining -= run;
    }
    state.merge_force_collapse(items);
}

/// [`sort_by`] with an [`Ordering`] comparator.
pub fn sort_by_ordering<T: Clone>(items: &mut [T], mut compare: impl FnMut(&T, &T) -> Ordering) {
    sort_by(items, |a, b| match compare(a, b) {
        Ordering::Less => -1.0,
        Ordering::Equal => 0.0,
        Ordering::Greater => 1.0,
    });
}

fn min_run_length(mut n: usize) -> usize {
    let mut r = 0;
    while n >= 64 {
        r |= n & 1;
        n >>= 1;
    }
    n + r
}

struct State<'c, T> {
    compare: &'c mut dyn FnMut(&T, &T) -> f64,
    min_gallop: usize,
    /// Pending runs: base and length.
    runs: Vec<(usize, usize)>,
}

impl<T: Clone> State<'_, T> {
    /// The comparator's sign: -1, 0 or 1, NaN as 0.
    fn order(&mut self, a: &T, b: &T) -> i32 {
        let v = (self.compare)(a, b);
        if v < 0.0 {
            -1
        } else if v > 0.0 {
            1
        } else {
            0
        }
    }

    /// The run starting at `low`: ascending, or strictly descending and then reversed.
    fn count_and_make_run(&mut self, a: &mut [T], low_arg: usize, high: usize) -> usize {
        let low = low_arg + 1;
        if low == high {
            return 1;
        }
        let mut run = 2;
        let element_low = a[low].clone();
        let element_low_pre = a[low - 1].clone();
        let descending = self.order(&element_low, &element_low_pre) < 0;
        let mut previous = element_low;
        for current in &a[low + 1..high] {
            let order = self.order(current, &previous);
            if descending {
                if order >= 0 {
                    break;
                }
            } else if order < 0 {
                break;
            }
            previous = current.clone();
            run += 1;
        }
        if descending {
            a[low_arg..low_arg + run].reverse();
        }
        run
    }

    /// Sorts `[low, high)` by binary insertion, `[low, start)` already sorted.
    fn binary_insertion_sort(&mut self, a: &mut [T], low: usize, start_arg: usize, high: usize) {
        let mut start = if low == start_arg {
            start_arg + 1
        } else {
            start_arg
        };
        while start < high {
            let mut left = low;
            let mut right = start;
            let pivot = a[start].clone();
            while left < right {
                let middle = left + ((right - left) >> 1);
                if self.order(&pivot, &a[middle]) < 0 {
                    right = middle;
                } else {
                    left = middle + 1;
                }
            }
            for p in (left + 1..=start).rev() {
                a[p] = a[p - 1].clone();
            }
            a[left] = pivot;
            start += 1;
        }
    }

    fn established(&self, n: usize) -> bool {
        if n < 2 {
            return true;
        }
        self.runs[n - 2].1 > self.runs[n - 1].1 + self.runs[n].1
    }

    fn merge_collapse(&mut self, a: &mut [T]) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if !self.established(n + 1) || !self.established(n) {
                if self.runs[n - 1].1 < self.runs[n + 1].1 {
                    n -= 1;
                }
                self.merge_at(a, n);
            } else if self.runs[n].1 <= self.runs[n + 1].1 {
                self.merge_at(a, n);
            } else {
                break;
            }
        }
    }

    fn merge_force_collapse(&mut self, a: &mut [T]) {
        while self.runs.len() > 1 {
            let mut n = self.runs.len() - 2;
            if n > 0 && self.runs[n - 1].1 < self.runs[n + 1].1 {
                n -= 1;
            }
            self.merge_at(a, n);
        }
    }

    fn merge_at(&mut self, a: &mut [T], i: usize) {
        let (mut base_a, mut length_a) = self.runs[i];
        let (base_b, mut length_b) = self.runs[i + 1];
        self.runs[i].1 = length_a + length_b;
        self.runs.remove(i + 1);
        // Where B's first element goes in A: what comes before stays put.
        let key = a[base_b].clone();
        let k = self.gallop_right(a, &key, base_a, length_a, 0);
        base_a += k;
        length_a -= k;
        if length_a == 0 {
            return;
        }
        // Where A's last element goes in B: what comes after stays put.
        let key = a[base_a + length_a - 1].clone();
        length_b = self.gallop_left(a, &key, base_b, length_b, length_b - 1);
        if length_b == 0 {
            return;
        }
        if length_a <= length_b {
            self.merge_low(a, base_a, length_a, base_b, length_b);
        } else {
            self.merge_high(a, base_a, length_a, base_b, length_b);
        }
    }

    /// The leftmost position in `array[base..base + length]` for `key`.
    fn gallop_left(
        &mut self,
        array: &[T],
        key: &T,
        base: usize,
        length: usize,
        hint: usize,
    ) -> usize {
        let mut last = 0isize;
        let mut offset = 1isize;
        let hint = hint as isize;
        let length = length as isize;
        let at = |i: isize| &array[(base as isize + i) as usize];
        if self.order(at(hint), key) < 0 {
            let max = length - hint;
            while offset < max {
                if self.order(at(hint + offset), key) >= 0 {
                    break;
                }
                last = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max);
            last += hint;
            offset += hint;
        } else {
            let max = hint + 1;
            while offset < max {
                if self.order(at(hint - offset), key) < 0 {
                    break;
                }
                last = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max);
            let tmp = last;
            last = hint - offset;
            offset = hint - tmp;
        }
        last += 1;
        while last < offset {
            let m = last + ((offset - last) >> 1);
            if self.order(at(m), key) < 0 {
                last = m + 1;
            } else {
                offset = m;
            }
        }
        offset as usize
    }

    /// The rightmost position in `array[base..base + length]` for `key`.
    fn gallop_right(
        &mut self,
        array: &[T],
        key: &T,
        base: usize,
        length: usize,
        hint: usize,
    ) -> usize {
        let mut last = 0isize;
        let mut offset = 1isize;
        let hint = hint as isize;
        let length = length as isize;
        let at = |i: isize| &array[(base as isize + i) as usize];
        if self.order(key, at(hint)) < 0 {
            let max = hint + 1;
            while offset < max {
                if self.order(key, at(hint - offset)) >= 0 {
                    break;
                }
                last = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max);
            let tmp = last;
            last = hint - offset;
            offset = hint - tmp;
        } else {
            let max = length - hint;
            while offset < max {
                if self.order(key, at(hint + offset)) < 0 {
                    break;
                }
                last = offset;
                offset = (offset << 1) + 1;
            }
            offset = offset.min(max);
            last += hint;
            offset += hint;
        }
        last += 1;
        while last < offset {
            let m = last + ((offset - last) >> 1);
            if self.order(key, at(m)) < 0 {
                offset = m;
            } else {
                last = m + 1;
            }
        }
        offset as usize
    }

    /// Merges A (copied aside) and B forwards; A is the shorter.
    fn merge_low(
        &mut self,
        a: &mut [T],
        base_a: usize,
        length_a: usize,
        base_b: usize,
        length_b: usize,
    ) {
        let mut length_a = length_a;
        let mut length_b = length_b;
        let temp: Vec<T> = a[base_a..base_a + length_a].to_vec();
        let mut dest = base_a;
        let mut cursor_temp = 0;
        let mut cursor_b = base_b;
        a[dest] = a[cursor_b].clone();
        dest += 1;
        cursor_b += 1;
        enum End {
            Succeed,
            CopyB,
        }
        let end = 'merge: {
            length_b -= 1;
            if length_b == 0 {
                break 'merge End::Succeed;
            }
            if length_a == 1 {
                break 'merge End::CopyB;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a = 0;
                let mut wins_b = 0;
                loop {
                    if self.order(&a[cursor_b], &temp[cursor_temp]) < 0 {
                        a[dest] = a[cursor_b].clone();
                        dest += 1;
                        cursor_b += 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                        if wins_b >= min_gallop {
                            break;
                        }
                    } else {
                        a[dest] = temp[cursor_temp].clone();
                        dest += 1;
                        cursor_temp += 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 1 {
                            break 'merge End::CopyB;
                        }
                        if wins_a >= min_gallop {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP || wins_b >= MIN_GALLOP || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = a[cursor_b].clone();
                    wins_a = self.gallop_right(&temp, &key, cursor_temp, length_a, 0);
                    if wins_a > 0 {
                        a[dest..dest + wins_a]
                            .clone_from_slice(&temp[cursor_temp..cursor_temp + wins_a]);
                        dest += wins_a;
                        cursor_temp += wins_a;
                        length_a -= wins_a;
                        if length_a == 1 {
                            break 'merge End::CopyB;
                        }
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    a[dest] = a[cursor_b].clone();
                    dest += 1;
                    cursor_b += 1;
                    length_b -= 1;
                    if length_b == 0 {
                        break 'merge End::Succeed;
                    }
                    let key = temp[cursor_temp].clone();
                    wins_b = self.gallop_left(a, &key, cursor_b, length_b, 0);
                    if wins_b > 0 {
                        for offset in 0..wins_b {
                            a[dest + offset] = a[cursor_b + offset].clone();
                        }
                        dest += wins_b;
                        cursor_b += wins_b;
                        length_b -= wins_b;
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    a[dest] = temp[cursor_temp].clone();
                    dest += 1;
                    cursor_temp += 1;
                    length_a -= 1;
                    if length_a == 1 {
                        break 'merge End::CopyB;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            End::Succeed => {
                if length_a > 0 {
                    a[dest..dest + length_a]
                        .clone_from_slice(&temp[cursor_temp..cursor_temp + length_a]);
                }
            }
            End::CopyB => {
                // The last element of A belongs at the end of the merge.
                for offset in 0..length_b {
                    a[dest + offset] = a[cursor_b + offset].clone();
                }
                a[dest + length_b] = temp[cursor_temp].clone();
            }
        }
    }

    /// Merges A and B (copied aside) backwards; B is the shorter.
    fn merge_high(
        &mut self,
        a: &mut [T],
        base_a: usize,
        length_a: usize,
        base_b: usize,
        length_b: usize,
    ) {
        let mut length_a = length_a as isize;
        let mut length_b = length_b as isize;
        let temp: Vec<T> = a[base_b..base_b + length_b as usize].to_vec();
        let mut dest = base_b as isize + length_b - 1;
        let mut cursor_temp = length_b - 1;
        let mut cursor_a = base_a as isize + length_a - 1;
        let base_a = base_a as isize;
        a[dest as usize] = a[cursor_a as usize].clone();
        dest -= 1;
        cursor_a -= 1;
        enum End {
            Succeed,
            CopyA,
        }
        let end = 'merge: {
            length_a -= 1;
            if length_a == 0 {
                break 'merge End::Succeed;
            }
            if length_b == 1 {
                break 'merge End::CopyA;
            }
            let mut min_gallop = self.min_gallop;
            loop {
                let mut wins_a = 0isize;
                let mut wins_b = 0isize;
                loop {
                    if self.order(&temp[cursor_temp as usize], &a[cursor_a as usize]) < 0 {
                        a[dest as usize] = a[cursor_a as usize].clone();
                        dest -= 1;
                        cursor_a -= 1;
                        wins_a += 1;
                        length_a -= 1;
                        wins_b = 0;
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                        if wins_a >= min_gallop as isize {
                            break;
                        }
                    } else {
                        a[dest as usize] = temp[cursor_temp as usize].clone();
                        dest -= 1;
                        cursor_temp -= 1;
                        wins_b += 1;
                        length_b -= 1;
                        wins_a = 0;
                        if length_b == 1 {
                            break 'merge End::CopyA;
                        }
                        if wins_b >= min_gallop as isize {
                            break;
                        }
                    }
                }
                min_gallop += 1;
                let mut first = true;
                while wins_a >= MIN_GALLOP as isize || wins_b >= MIN_GALLOP as isize || first {
                    first = false;
                    min_gallop = min_gallop.saturating_sub(1).max(1);
                    self.min_gallop = min_gallop;
                    let key = temp[cursor_temp as usize].clone();
                    let k = self.gallop_right(
                        a,
                        &key,
                        base_a as usize,
                        length_a as usize,
                        (length_a - 1) as usize,
                    ) as isize;
                    wins_a = length_a - k;
                    if wins_a > 0 {
                        dest -= wins_a;
                        cursor_a -= wins_a;
                        for offset in (0..wins_a).rev() {
                            a[(dest + 1 + offset) as usize] =
                                a[(cursor_a + 1 + offset) as usize].clone();
                        }
                        length_a -= wins_a;
                        if length_a == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    a[dest as usize] = temp[cursor_temp as usize].clone();
                    dest -= 1;
                    cursor_temp -= 1;
                    length_b -= 1;
                    if length_b == 1 {
                        break 'merge End::CopyA;
                    }
                    let key = a[cursor_a as usize].clone();
                    let k = self.gallop_left(
                        &temp,
                        &key,
                        0,
                        length_b as usize,
                        (length_b - 1) as usize,
                    ) as isize;
                    wins_b = length_b - k;
                    if wins_b > 0 {
                        dest -= wins_b;
                        cursor_temp -= wins_b;
                        for offset in 0..wins_b {
                            a[(dest + 1 + offset) as usize] =
                                temp[(cursor_temp + 1 + offset) as usize].clone();
                        }
                        length_b -= wins_b;
                        if length_b == 1 {
                            break 'merge End::CopyA;
                        }
                        if length_b == 0 {
                            break 'merge End::Succeed;
                        }
                    }
                    a[dest as usize] = a[cursor_a as usize].clone();
                    dest -= 1;
                    cursor_a -= 1;
                    length_a -= 1;
                    if length_a == 0 {
                        break 'merge End::Succeed;
                    }
                }
                min_gallop += 1;
                self.min_gallop = min_gallop;
            }
        };
        match end {
            End::Succeed => {
                if length_b > 0 {
                    let start = (dest - (length_b - 1)) as usize;
                    a[start..start + length_b as usize]
                        .clone_from_slice(&temp[..length_b as usize]);
                }
            }
            End::CopyA => {
                // The first element of B belongs at the front of the merge.
                dest -= length_a;
                cursor_a -= length_a;
                for offset in (0..length_a).rev() {
                    a[(dest + 1 + offset) as usize] = a[(cursor_a + 1 + offset) as usize].clone();
                }
                a[dest as usize] = temp[cursor_temp as usize].clone();
            }
        }
    }
}
