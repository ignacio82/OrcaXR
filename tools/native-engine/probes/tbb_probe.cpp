// Dependency feasibility probe. It does not qualify libslic3r painting or slicing.
#include <oneapi/tbb/global_control.h>
#include <oneapi/tbb/parallel_for.h>
#include <oneapi/tbb/parallel_reduce.h>
#include <oneapi/tbb/scalable_allocator.h>
#include <oneapi/tbb/task_group.h>
#include <oneapi/tbb/version.h>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <thread>
#include <vector>
#include <unistd.h>

namespace {
constexpr size_t slots = 512;
constexpr size_t rounds = 16;
struct Block { unsigned char* bytes = nullptr; size_t size = 0; unsigned char pattern = 0; };
void require(bool ok) { if (!ok) throw std::runtime_error("Native TBB probe failed"); }
void allocators() {
    std::vector<Block> blocks(slots);
    std::atomic<bool> valid{true};
    for (size_t round = 0; round < rounds; ++round) {
        oneapi::tbb::parallel_for(size_t{0}, slots, [&](size_t i) {
            auto& b = blocks[i];
            b.size = 1 + ((i * 977 + round * 31) % 65536);
            b.pattern = static_cast<unsigned char>((i * 7 + round) % 251);
            b.bytes = static_cast<unsigned char*>(scalable_malloc(b.size));
            require(b.bytes != nullptr);
            std::memset(b.bytes, b.pattern, b.size);
            const auto grown = b.size + 8193;
            auto* resized = static_cast<unsigned char*>(scalable_realloc(b.bytes, grown));
            require(resized != nullptr);
            b.bytes = resized;
            for (size_t n = 0; n < b.size; ++n) if (b.bytes[n] != b.pattern) valid = false;
            std::memset(b.bytes, b.pattern, grown);
            b.size = grown;
        });
        // Free on different native threads after producer completion; no shared
        // slot is read or released by more than one consumer.
        std::vector<std::thread> consumers;
        for (size_t worker = 0; worker < 4; ++worker) consumers.emplace_back([&, worker] {
            for (size_t i = worker; i < slots; i += 4) {
                auto& b = blocks[slots - 1 - i];
                for (size_t n = 0; n < b.size; ++n) if (b.bytes[n] != b.pattern) valid = false;
                scalable_free(b.bytes); b.bytes = nullptr;
            }
        });
        for (auto& consumer : consumers) consumer.join();
    }
    require(valid);
    for (size_t alignment : {size_t{64}, size_t{4096}, size_t{16384}, size_t{65536}}) {
        for (size_t size : {size_t{1}, size_t{16383}, size_t{16384}, size_t{16385}, size_t{65537}}) {
            void* memory = scalable_aligned_malloc(size, alignment);
            require(memory && reinterpret_cast<uintptr_t>(memory) % alignment == 0);
            std::memset(memory, 0xa5, size);
            scalable_aligned_free(memory);
        }
    }
}
void scheduling() {
    constexpr size_t count = 1'000'003;
    std::vector<uint64_t> values(count);
    oneapi::tbb::task_group jobs;
    jobs.run([&] {
        oneapi::tbb::parallel_for(size_t{0}, count, [&](size_t i) { values[i] = i; });
    });
    jobs.wait();
    const auto sum = oneapi::tbb::parallel_reduce(oneapi::tbb::blocked_range<size_t>(0, count), uint64_t{0},
        [&](const auto& range, uint64_t initial) {
            for (auto i = range.begin(); i != range.end(); ++i) initial += values[i];
            return initial;
        }, [](uint64_t a, uint64_t b) { return a + b; });
    require(sum == uint64_t{count} * (count - 1) / 2);
}
}
int main() {
    try {
        // This cap only bounds this synthetic dependency probe. It says nothing
        // about libslic3r task graphs and must not become an engine thread policy.
        oneapi::tbb::global_control limit(oneapi::tbb::global_control::max_allowed_parallelism, 4);
        allocators(); scheduling();
        require(TBB_runtime_interface_version() == TBB_INTERFACE_VERSION);
        std::printf("{\"schemaVersion\":1,\"passed\":true,\"tbbInterface\":%d,\"pageSize\":%ld,"
                    "\"allocationRounds\":%zu,\"allocationsPerRound\":%zu,\"alignedCases\":20,"
                    "\"parallelItems\":1000003,\"slicingQualified\":false}\n",
                    TBB_runtime_interface_version(), sysconf(_SC_PAGESIZE), rounds, slots);
        return 0;
    } catch (...) {
        std::fputs("Native TBB dependency probe failed\n", stderr);
        return 1;
    }
}
