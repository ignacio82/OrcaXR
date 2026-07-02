/*
    TBB Serial Shim: parallel_pipeline.h  (OrcaXR WASM)

    Serial pipeline: tokens flow one at a time through the filter chain
    on the calling thread — exactly the semantics of a 1-token pipeline,
    which is a legal execution of any tbb::parallel_pipeline. Used by
    the WebAssembly build where oneTBB task dispatch deadlocks; the
    consumer is GCode.cpp's gcode post-processing stream.

    Implements the oneTBB 2021 filter API surface libslic3r uses:
    filter<T,U>, make_filter<T,U>(mode, fn), filter_mode, flow_control,
    operator& chaining, parallel_pipeline(max_tokens, filter<void,void>).

    Activates only when ORCAXR_TBB_SERIAL_ACTIVE is defined; otherwise
    falls through to real TBB.
*/

#ifdef ORCAXR_TBB_SERIAL_ACTIVE

#ifndef __ORCAXR_TBB_SERIAL_PARALLEL_PIPELINE_H
#define __ORCAXR_TBB_SERIAL_PARALLEL_PIPELINE_H

// Block the real headers (oneTBB 2021.x guard names).
#ifndef __TBB_parallel_pipeline_H
#define __TBB_parallel_pipeline_H
#endif

#include <cstddef>
#include <cstdio>
#include <functional>
#include <memory>
#include <type_traits>
#include <utility>

namespace tbb {

enum class filter_mode { parallel, serial_in_order, serial_out_of_order };

class flow_control {
public:
    void stop() { m_stopped = true; }
    bool is_stopped() const { return m_stopped; }

private:
    bool m_stopped = false;
};

template <typename T, typename U> class filter;

// Middle stage: T -> U.
template <typename T, typename U> class filter {
public:
    filter() = default;
    filter(filter_mode, std::function<U(T)> fn) : m_fn(std::move(fn)) {}
    U operator()(T t) const { return m_fn(std::move(t)); }
    bool valid() const { return static_cast<bool>(m_fn); }

    std::function<U(T)> m_fn;
};

// Input stage: flow_control& -> U.
template <typename U> class filter<void, U> {
public:
    filter() = default;
    filter(filter_mode, std::function<U(flow_control &)> fn) : m_fn(std::move(fn)) {}
    U operator()(flow_control &fc) const { return m_fn(fc); }
    bool valid() const { return static_cast<bool>(m_fn); }

    std::function<U(flow_control &)> m_fn;
};

// Output stage: T -> void.
template <typename T> class filter<T, void> {
public:
    filter() = default;
    filter(filter_mode, std::function<void(T)> fn) : m_fn(std::move(fn)) {}
    void operator()(T t) const { m_fn(std::move(t)); }
    bool valid() const { return static_cast<bool>(m_fn); }

    std::function<void(T)> m_fn;
};

// Whole pipeline: run one token at a time until the input stage stops.
template <> class filter<void, void> {
public:
    filter() = default;
    explicit filter(std::function<bool()> run_one) : m_run_one(std::move(run_one)) {}
    /// @return false when the input stage called flow_control::stop().
    bool run_one() const { return m_run_one(); }
    bool valid() const { return static_cast<bool>(m_run_one); }

    std::function<bool()> m_run_one;
};

template <typename T, typename U>
filter<T, U> make_filter(filter_mode mode, std::function<U(T)> fn)
{
    return filter<T, U>(mode, std::move(fn));
}

template <typename T, typename U, typename Body>
filter<T, U> make_filter(filter_mode mode, const Body &body)
{
    if constexpr (std::is_void_v<T>) {
        return filter<void, U>(mode, std::function<U(flow_control &)>(body));
    } else if constexpr (std::is_void_v<U>) {
        return filter<T, void>(mode, std::function<void(T)>(body));
    } else {
        return filter<T, U>(mode, std::function<U(T)>(body));
    }
}

// Chaining. Results share ownership of the two sides via copies (the
// filters hold std::functions, cheap enough for pipeline construction).
template <typename T, typename U, typename V>
filter<T, V> operator&(const filter<T, U> &a, const filter<U, V> &b)
{
    return filter<T, V>(filter_mode::serial_in_order,
                        [a, b](T t) { return b(a(std::move(t))); });
}

template <typename U, typename V>
filter<void, V> operator&(const filter<void, U> &a, const filter<U, V> &b)
{
    if constexpr (std::is_void_v<V>) {
        // Input & rest -> full pipeline runner.
        return filter<void, void>([a, b]() -> bool {
            flow_control fc;
            U token = a(fc);
            if (fc.is_stopped()) return false;
            b(std::move(token));
            return true;
        });
    } else {
        return filter<void, V>(filter_mode::serial_in_order,
                               [a, b](flow_control &fc) {
                                   U token = a(fc);
                                   if (fc.is_stopped()) return V();
                                   return b(std::move(token));
                               });
    }
}

inline void parallel_pipeline(std::size_t /*max_number_of_live_tokens*/,
                              const filter<void, void> &pipeline)
{
    std::fprintf(stderr, "[orcaxr] serial pipeline: start\n");
    while (pipeline.run_one()) {
    }
    std::fprintf(stderr, "[orcaxr] serial pipeline: end\n");
}

} // namespace tbb

#endif // __ORCAXR_TBB_SERIAL_PARALLEL_PIPELINE_H

#else // !ORCAXR_TBB_SERIAL_ACTIVE
#include_next <tbb/parallel_pipeline.h>
#endif
