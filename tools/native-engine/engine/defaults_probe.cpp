#include "defaults_probe.hpp"
#include "libslic3r/Print.hpp"
#include <cstring>
#include <memory>
#include <new>
#include <stdexcept>

namespace {
template<class T> struct Destroy {
    void operator()(T* value) const {
        value->~T();
        ::operator delete(value, std::align_val_t{alignof(T)});
    }
};

// Default initialization is intentional: value initialization could hide a
// missing member initializer with zeroed storage. Construct actual engine types.
template<class T> std::unique_ptr<T, Destroy<T>> poisoned(unsigned char pattern) {
    void* storage = ::operator new(sizeof(T), std::align_val_t{alignof(T)});
    std::memset(storage, pattern, sizeof(T));
    try {
        return std::unique_ptr<T, Destroy<T>>(::new (storage) T);
    } catch (...) {
        ::operator delete(storage, std::align_val_t{alignof(T)});
        throw;
    }
}

void require(bool condition) {
    if (!condition) throw std::runtime_error("Native engine initialization check failed");
}
}

void check_engine_defaults() {
    for (unsigned char pattern : {0x00, 0x5a, 0xa5, 0xff}) {
        auto print = poisoned<Slic3r::Print>(pattern);
        // Examine the bool representation first, without reading a potentially
        // invalid bool value if the source initializer regresses.
        const bool expected = false;
        require(std::memcmp(&print->is_BBL_printer(), &expected, sizeof(bool)) == 0);
        require(print->get_plate_origin() == Slic3r::Vec3d::Zero());
        require(print->get_plate_index() == 0);
        print->is_BBL_printer() = true;
        print->set_plate_origin(Slic3r::Vec3d(12.5, -7.25, 0.0));
        print->set_plate_index(3);
        require(print->is_BBL_printer());
        require(print->get_plate_origin() == Slic3r::Vec3d(12.5, -7.25, 0.0));
        require(print->get_plate_index() == 3);

        auto tower = poisoned<Slic3r::FakeWipeTower>(pattern);
        require(tower->pos == Slic3r::Vec2f::Zero());
        require(tower->plate_origin == Slic3r::Vec2d::Zero());
        require(tower->width == 0.f && tower->height == 0.f && tower->layer_height == 0.f);
        require(tower->depth == 0.f && tower->brim_width == 0.f);
        require(tower->rotation_angle == 0.f && tower->cone_angle == 0.f);
        require(tower->z_and_depth_pairs.empty());
        require(tower->getFakeExtrusionPathsFromWipeTower().empty());
        tower->set_fake_extrusion_data(Slic3r::Vec2f(10.f, 20.f), 30.f, 0.4f, 0.2f,
                                      40.f, 2.f, Slic3r::Vec2d(3.0, 4.0));
        require(tower->pos == Slic3r::Vec2f(10.f, 20.f));
        require(tower->plate_origin == Slic3r::Vec2d(3.0, 4.0));
        require(tower->width == 30.f && tower->height == 0.4f && tower->layer_height == 0.2f);
        require(tower->depth == 40.f && tower->brim_width == 2.f);
        require(tower->rotation_angle == 0.f && tower->cone_angle == 0.f);
        require(tower->getFakeExtrusionPathsFromWipeTower().size() == 2);
    }
}
