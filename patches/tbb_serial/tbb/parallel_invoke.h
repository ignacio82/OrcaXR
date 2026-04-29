/*
    TBB Serial Shim: parallel_invoke.h
    Opt-in via ORCAXR_TBB_SERIAL_ACTIVE — see parallel_for.h header for
    the full rationale.
*/

#ifdef ORCAXR_TBB_SERIAL_ACTIVE

#ifndef __ORCAXR_TBB_SERIAL_PARALLEL_INVOKE_H
#define __ORCAXR_TBB_SERIAL_PARALLEL_INVOKE_H

#ifndef __TBB_parallel_invoke_H
#define __TBB_parallel_invoke_H 1
#endif

#include <tbb/partitioner.h>

#include <utility>

namespace tbb {
namespace detail {
namespace d1 {

// Variadic: call all functions sequentially.
// The real TBB API allows the last argument to be a task_group_context&.
// We handle both cases via overload resolution.

// Base case: 2+ callables, no context
template<typename F1, typename F2>
void parallel_invoke(const F1& f1, const F2& f2) {
    f1();
    f2();
}

template<typename F1, typename F2, typename F3>
void parallel_invoke(const F1& f1, const F2& f2, const F3& f3) {
    f1();
    f2();
    f3();
}

template<typename F1, typename F2, typename F3, typename F4>
void parallel_invoke(const F1& f1, const F2& f2, const F3& f3, const F4& f4) {
    f1();
    f2();
    f3();
    f4();
}

template<typename F1, typename F2, typename F3, typename F4, typename F5>
void parallel_invoke(const F1& f1, const F2& f2, const F3& f3, const F4& f4, const F5& f5) {
    f1();
    f2();
    f3();
    f4();
    f5();
}

template<typename F1, typename F2, typename F3, typename F4, typename F5, typename F6>
void parallel_invoke(const F1& f1, const F2& f2, const F3& f3, const F4& f4, const F5& f5, const F6& f6) {
    f1();
    f2();
    f3();
    f4();
    f5();
    f6();
}

template<typename F1, typename F2, typename F3, typename F4, typename F5, typename F6, typename F7>
void parallel_invoke(const F1& f1, const F2& f2, const F3& f3, const F4& f4, const F5& f5, const F6& f6, const F7& f7) {
    f1();
    f2();
    f3();
    f4();
    f5();
    f6();
    f7();
}

template<typename F1, typename F2, typename F3, typename F4, typename F5, typename F6, typename F7, typename F8>
void parallel_invoke(const F1& f1, const F2& f2, const F3& f3, const F4& f4, const F5& f5, const F6& f6, const F7& f7, const F8& f8) {
    f1();
    f2();
    f3();
    f4();
    f5();
    f6();
    f7();
    f8();
}

template<typename F1, typename F2, typename F3, typename F4, typename F5, typename F6, typename F7, typename F8, typename F9>
void parallel_invoke(const F1& f1, const F2& f2, const F3& f3, const F4& f4, const F5& f5, const F6& f6, const F7& f7, const F8& f8, const F9& f9) {
    f1();
    f2();
    f3();
    f4();
    f5();
    f6();
    f7();
    f8();
    f9();
}

template<typename F1, typename F2, typename F3, typename F4, typename F5, typename F6, typename F7, typename F8, typename F9, typename F10>
void parallel_invoke(const F1& f1, const F2& f2, const F3& f3, const F4& f4, const F5& f5, const F6& f6, const F7& f7, const F8& f8, const F9& f9, const F10& f10) {
    f1();
    f2();
    f3();
    f4();
    f5();
    f6();
    f7();
    f8();
    f9();
    f10();
}

// With task_group_context as first argument (context ignored in serial mode)
template<typename F1, typename F2>
void parallel_invoke(task_group_context&, const F1& f1, const F2& f2) {
    f1();
    f2();
}

template<typename F1, typename F2, typename F3>
void parallel_invoke(task_group_context&, const F1& f1, const F2& f2, const F3& f3) {
    f1();
    f2();
    f3();
}

} // namespace d1
} // namespace detail

inline namespace v1 {
using detail::d1::parallel_invoke;
} // namespace v1

} // namespace tbb

#endif /* __ORCAXR_TBB_SERIAL_PARALLEL_INVOKE_H */

#else  // ORCAXR_TBB_SERIAL_ACTIVE not defined: forward to real TBB

#include_next <tbb/parallel_invoke.h>

#endif // ORCAXR_TBB_SERIAL_ACTIVE
