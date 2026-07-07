/*
    TBB Serial Shim: tbb.h umbrella  (OrcaXR WASM)

    The real umbrella includes its siblings with QUOTED RELATIVE paths,
    bypassing the include-path interception that routes the parallel
    algorithms to the serial shims. Re-issue the includes through the
    search path instead so the shimmed algorithm headers win; everything
    else resolves to real oneTBB. Active only under
    ORCAXR_TBB_SERIAL_ACTIVE; otherwise falls through to real TBB.
*/
#ifdef ORCAXR_TBB_SERIAL_ACTIVE

#ifndef __ORCAXR_TBB_SERIAL_UMBRELLA_H
#define __ORCAXR_TBB_SERIAL_UMBRELLA_H

// Block the real umbrellas.
#ifndef __TBB_tbb_H
#define __TBB_tbb_H
#endif

// Shimmed algorithm headers (resolve to src/libslic3r/tbb/ copies).
#include <tbb/parallel_for.h>
#include <tbb/parallel_for_each.h>
#include <tbb/parallel_invoke.h>
#include <tbb/parallel_reduce.h>
#include <tbb/parallel_sort.h>
#include <tbb/parallel_pipeline.h>

// Real oneTBB pieces (no serial equivalent needed).
#include <tbb/blocked_range.h>
#include <tbb/blocked_range2d.h>
#include <tbb/cache_aligned_allocator.h>
#include <tbb/combinable.h>
#include <tbb/concurrent_hash_map.h>
#include <tbb/concurrent_queue.h>
#include <tbb/concurrent_unordered_map.h>
#include <tbb/concurrent_unordered_set.h>
#include <tbb/concurrent_vector.h>
#include <tbb/enumerable_thread_specific.h>
#include <tbb/global_control.h>
#include <tbb/null_mutex.h>
#include <tbb/queuing_mutex.h>
#include <tbb/scalable_allocator.h>
#include <tbb/spin_mutex.h>
#include <tbb/task_arena.h>
#include <tbb/task_group.h>
#include <tbb/tick_count.h>

#endif // __ORCAXR_TBB_SERIAL_UMBRELLA_H

#else // !ORCAXR_TBB_SERIAL_ACTIVE
#include_next <tbb/tbb.h>
#endif
