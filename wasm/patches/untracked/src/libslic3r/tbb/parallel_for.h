/*
    TBB Serial Shim: parallel_for.h

    Replaces TBB's parallel_for with serial execution to prevent data
    races on ARM64's weak memory ordering. The crash that motivates the
    shim is a SIGSEGV in `Slic3r::get_extents(vector<ExPolygon>) +128`
    inside `apply_mm_segmentation` (PrintObjectSlice.cpp:885), where
    `multi_material_segmentation_by_painting`'s parallel_for body
    reallocates ExPolygon vectors concurrently and the wrong half-
    constructed vector reaches `get_extents`. Single-threaded loop
    iteration removes the race.

    OPT-IN: this shim only activates when the consuming TU defines
    `ORCAXR_TBB_SERIAL_ACTIVE` BEFORE including any TBB header. A
    blanket serial replacement deadlocks libslic3r in places that rely
    on actual concurrency (TBB worker scheduling around task_group
    waits, atomic-counter barriers, etc.), so we apply the shim only
    where it's needed — currently MultiMaterialSegmentation.cpp and
    PrintObjectSlice.cpp (where apply_mm_segmentation is inlined).

    Other TUs include this header transitively (because
    `src/libslic3r/tbb/` is first on the libslic3r include path) but
    fall through to the real TBB via `#include_next`.

    Non-shimmed headers (blocked_range, partitioner, task_group,
    mutexes, concurrent containers) always come from real TBB —
    only the parallel-execution algorithms are intercepted, and only
    in the opt-in TUs.
*/

#ifdef ORCAXR_TBB_SERIAL_ACTIVE

#ifndef __ORCAXR_TBB_SERIAL_PARALLEL_FOR_H
#define __ORCAXR_TBB_SERIAL_PARALLEL_FOR_H

// Make sure real TBB's `<tbb/parallel_for.h>` is not loaded into this
// TU — the serial impls below reuse the same `tbb::detail::d1::`
// namespace and would collide. Set the real header's guard so any
// transitive include becomes a no-op.
#ifndef __TBB_parallel_for_H
#define __TBB_parallel_for_H 1
#endif

// Fall through to real TBB for types we need (Range concept,
// partitioner tags, task_group_context).
#include <tbb/blocked_range.h>
#include <tbb/partitioner.h>

#include <cstddef>
#include <stdexcept>

namespace tbb {
namespace detail {
namespace d1 {

// --- Internal: split range into grain-sized chunks and call body on each ---
// Pure recursion on both halves. Stack depth is O(log(range_size /
// grain_size)) — safe for any practical range. The earlier tail-recursive
// variant did `range = right;` after recursing on the left, but some
// TBB Range types (notably OpenVDB's `NodeRange<...>`) have an
// implicitly-deleted copy assignment operator, which made the shim
// fail to compile. Two recursive calls avoid the assignment.
template<typename Range, typename Body>
void serial_for_each_grain( Range range, const Body& body ) {
    if (range.is_divisible()) {
        Range right(range, tbb::split());  // splits range into left/right in-place
        serial_for_each_grain(range, body);   // process left
        serial_for_each_grain(right, body);   // process right
    } else {
        body(range);
    }
}

// --- Range + Body forms ---

template<typename Range, typename Body>
void parallel_for( const Range& range, const Body& body ) {
    serial_for_each_grain(Range(range), body);
}

template<typename Range, typename Body>
void parallel_for( const Range& range, const Body& body, const simple_partitioner& ) {
    serial_for_each_grain(Range(range), body);
}

template<typename Range, typename Body>
void parallel_for( const Range& range, const Body& body, const auto_partitioner& ) {
    serial_for_each_grain(Range(range), body);
}

template<typename Range, typename Body>
void parallel_for( const Range& range, const Body& body, const static_partitioner& ) {
    serial_for_each_grain(Range(range), body);
}

template<typename Range, typename Body>
void parallel_for( const Range& range, const Body& body, affinity_partitioner& ) {
    serial_for_each_grain(Range(range), body);
}

// With task_group_context (ignored in serial mode)

template<typename Range, typename Body>
void parallel_for( const Range& range, const Body& body, task_group_context& ) {
    serial_for_each_grain(Range(range), body);
}

template<typename Range, typename Body>
void parallel_for( const Range& range, const Body& body, const simple_partitioner&, task_group_context& ) {
    serial_for_each_grain(Range(range), body);
}

template<typename Range, typename Body>
void parallel_for( const Range& range, const Body& body, const auto_partitioner&, task_group_context& ) {
    serial_for_each_grain(Range(range), body);
}

template<typename Range, typename Body>
void parallel_for( const Range& range, const Body& body, const static_partitioner&, task_group_context& ) {
    serial_for_each_grain(Range(range), body);
}

template<typename Range, typename Body>
void parallel_for( const Range& range, const Body& body, affinity_partitioner&, task_group_context& ) {
    serial_for_each_grain(Range(range), body);
}

// --- Index range forms ---
// Serial: iterate from first to last, calling f(i) for each index.

// With step
template<typename Index, typename Function>
void parallel_for( Index first, Index last, Index step, const Function& f ) {
    if (step <= Index(0))
        throw std::invalid_argument("Step must be positive in parallel_for");
    for (Index i = first; i < last; i = i + step)
        f(i);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, Index step, const Function& f, const simple_partitioner& ) {
    parallel_for(first, last, step, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, Index step, const Function& f, const auto_partitioner& ) {
    parallel_for(first, last, step, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, Index step, const Function& f, const static_partitioner& ) {
    parallel_for(first, last, step, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, Index step, const Function& f, affinity_partitioner& ) {
    parallel_for(first, last, step, f);
}

// Without step (default step = 1)
template<typename Index, typename Function>
void parallel_for( Index first, Index last, const Function& f ) {
    for (Index i = first; i < last; ++i)
        f(i);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, const Function& f, const simple_partitioner& ) {
    parallel_for(first, last, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, const Function& f, const auto_partitioner& ) {
    parallel_for(first, last, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, const Function& f, const static_partitioner& ) {
    parallel_for(first, last, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, const Function& f, affinity_partitioner& ) {
    parallel_for(first, last, f);
}

// With step + context
template<typename Index, typename Function>
void parallel_for( Index first, Index last, Index step, const Function& f, task_group_context& ) {
    parallel_for(first, last, step, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, Index step, const Function& f, const simple_partitioner&, task_group_context& ) {
    parallel_for(first, last, step, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, Index step, const Function& f, const auto_partitioner&, task_group_context& ) {
    parallel_for(first, last, step, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, Index step, const Function& f, const static_partitioner&, task_group_context& ) {
    parallel_for(first, last, step, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, Index step, const Function& f, affinity_partitioner&, task_group_context& ) {
    parallel_for(first, last, step, f);
}

// Without step + context
template<typename Index, typename Function>
void parallel_for( Index first, Index last, const Function& f, task_group_context& ) {
    parallel_for(first, last, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, const Function& f, const simple_partitioner&, task_group_context& ) {
    parallel_for(first, last, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, const Function& f, const auto_partitioner&, task_group_context& ) {
    parallel_for(first, last, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, const Function& f, const static_partitioner&, task_group_context& ) {
    parallel_for(first, last, f);
}

template<typename Index, typename Function>
void parallel_for( Index first, Index last, const Function& f, affinity_partitioner&, task_group_context& ) {
    parallel_for(first, last, f);
}

} // namespace d1
} // namespace detail

inline namespace v1 {
using detail::d1::parallel_for;
// Split types (needed by callers)
using detail::split;
using detail::proportional_split;
} // namespace v1

} // namespace tbb

#endif /* __ORCAXR_TBB_SERIAL_PARALLEL_FOR_H */

#else  // ORCAXR_TBB_SERIAL_ACTIVE not defined: forward to real TBB

#include_next <tbb/parallel_for.h>

#endif // ORCAXR_TBB_SERIAL_ACTIVE
