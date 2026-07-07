/*
    TBB Serial Shim: parallel_sort.h
    Opt-in via ORCAXR_TBB_SERIAL_ACTIVE — see parallel_for.h header for
    the full rationale.
*/

#ifdef ORCAXR_TBB_SERIAL_ACTIVE

#ifndef __ORCAXR_TBB_SERIAL_PARALLEL_SORT_H
#define __ORCAXR_TBB_SERIAL_PARALLEL_SORT_H

#ifndef __TBB_parallel_sort_H
#define __TBB_parallel_sort_H 1
#endif

#include <algorithm>
#include <iterator>
#include <functional>

namespace tbb {
namespace detail {
namespace d1 {

template<typename RandomAccessIterator, typename Compare>
void parallel_sort( RandomAccessIterator begin, RandomAccessIterator end, const Compare& comp ) {
    std::sort(begin, end, comp);
}

template<typename RandomAccessIterator>
void parallel_sort( RandomAccessIterator begin, RandomAccessIterator end ) {
    std::sort(begin, end);
}

template<typename Range, typename Compare>
void parallel_sort( Range&& rng, const Compare& comp ) {
    std::sort(std::begin(rng), std::end(rng), comp);
}

template<typename Range>
void parallel_sort( Range&& rng ) {
    std::sort(std::begin(rng), std::end(rng));
}

} // namespace d1
} // namespace detail

inline namespace v1 {
using detail::d1::parallel_sort;
} // namespace v1
} // namespace tbb

#endif /* __ORCAXR_TBB_SERIAL_PARALLEL_SORT_H */

#else  // ORCAXR_TBB_SERIAL_ACTIVE not defined: forward to real TBB

#include_next <tbb/parallel_sort.h>

#endif // ORCAXR_TBB_SERIAL_ACTIVE
