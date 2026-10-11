//! `Math.sin`, `Math.cos`, `Math.tan`, `Math.exp`, `Math.acos`, `Math.asin`,
//! `Math.atan` and `Math.atan2` exactly as V8 computes them: a line-for-line port of V8 12.4's `src/base/ieee754.cc` (fdlibm 5.3, which
//! Node 22's V8 uses for sin/cos rather than its optional glibc routines), not
//! the later FreeBSD msun revisions the `libm` crate follows (different
//! `__kernel_cos`, `init_jk` and reduction thresholds), plus V8's `exp(1) = E`.
//!
//! The following is adapted from fdlibm (http://www.netlib.org/fdlibm).
//! Copyright (C) 1993 by Sun Microsystems, Inc. All rights reserved.
//! Developed at SunSoft, a Sun Microsystems, Inc. business. Permission to use,
//! copy, modify, and distribute this software is freely granted, provided that
//! this notice is preserved. Modified by Google Inc.; Copyright 2016 the V8
//! project authors. All rights reserved.
//!
//! Constants keep fdlibm's decimal literals (Rust and C both round them
//! correctly), and every expression keeps the C grouping. Rust never fuses
//! multiply-add, matching V8's x86-64 build.
#![allow(clippy::excessive_precision, clippy::approx_constant)] // fdlibm's literals, verbatim.

fn high(x: f64) -> i32 {
    (x.to_bits() >> 32) as u32 as i32
}
fn low(x: f64) -> u32 {
    x.to_bits() as u32
}
fn words(high: i32, low: u32) -> f64 {
    f64::from_bits(((high as u32 as u64) << 32) | low as u64)
}

fn kernel_cos(x: f64, y: f64) -> f64 {
    const ONE: f64 = 1.00000000000000000000e+00;
    const C1: f64 = 4.16666666666666019037e-02;
    const C2: f64 = -1.38888888888741095749e-03;
    const C3: f64 = 2.48015872894767294178e-05;
    const C4: f64 = -2.75573143513906633035e-07;
    const C5: f64 = 2.08757232129817482790e-09;
    const C6: f64 = -1.13596475577881948265e-11;
    let ix = high(x) & 0x7FFFFFFF;
    if ix < 0x3E400000 && x as i32 == 0 {
        return ONE;
    }
    let z = x * x;
    let r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    if ix < 0x3FD33333 {
        ONE - (0.5 * z - (z * r - x * y))
    } else {
        let qx = if ix > 0x3FE90000 {
            0.28125
        } else {
            words(ix - 0x00200000, 0)
        };
        let iz = 0.5 * z - qx;
        let a = ONE - qx;
        a - (iz - (z * r - x * y))
    }
}

fn kernel_sin(x: f64, y: f64, iy: i32) -> f64 {
    const HALF: f64 = 5.00000000000000000000e-01;
    const S1: f64 = -1.66666666666666324348e-01;
    const S2: f64 = 8.33333333332248946124e-03;
    const S3: f64 = -1.98412698298579493134e-04;
    const S4: f64 = 2.75573137070700676789e-06;
    const S5: f64 = -2.50507602534068634195e-08;
    const S6: f64 = 1.58969099521155010221e-10;
    let ix = high(x) & 0x7FFFFFFF;
    if ix < 0x3E400000 && x as i32 == 0 {
        return x;
    }
    let z = x * x;
    let v = z * x;
    let r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    if iy == 0 {
        x + v * (S1 + z * r)
    } else {
        x - ((z * (HALF * y - v * r) - y) - v * S1)
    }
}

/// Table of constants for 2/pi, 396 hex digits.
const TWO_OVER_PI: [i32; 66] = [
    0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62, 0x95993C, 0x439041, 0xFE5163,
    0xABDEBB, 0xC561B7, 0x246E3A, 0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129,
    0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41, 0x3991D6, 0x398353, 0x39F49C,
    0x845F8B, 0xBDF928, 0x3B1FF8, 0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF,
    0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5, 0xF17B3D, 0x0739F7, 0x8A5292,
    0xEA6BFB, 0x5FB11F, 0x8D5D08, 0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3,
    0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880, 0x4D7327, 0x310606, 0x1556CA,
    0x73A8C9, 0x60E27B, 0xC08C6B,
];
const NPIO2_HW: [i32; 32] = [
    0x3FF921FB, 0x400921FB, 0x4012D97C, 0x401921FB, 0x401F6A7A, 0x4022D97C, 0x4025FDBB, 0x402921FB,
    0x402C463A, 0x402F6A7A, 0x4031475C, 0x4032D97C, 0x40346B9C, 0x4035FDBB, 0x40378FDB, 0x403921FB,
    0x403AB41B, 0x403C463A, 0x403DD85A, 0x403F6A7A, 0x40407E4C, 0x4041475C, 0x4042106C, 0x4042D97C,
    0x4043A28C, 0x40446B9C, 0x404534AC, 0x4045FDBB, 0x4046C6CB, 0x40478FDB, 0x404858EB, 0x404921FB,
];

/// `__kernel_rem_pio2` with `prec = 2` (the only precision V8 uses here).
#[allow(clippy::needless_range_loop)] // index arithmetic kept as in C
fn kernel_rem_pio2(x: &[f64; 3], y: &mut [f64; 2], e0: i32, nx: usize) -> i32 {
    const PIO2: [f64; 8] = [
        1.57079625129699707031e+00,
        7.54978941586159635335e-08,
        5.39030252995776476554e-15,
        3.28200341580791294123e-22,
        1.27065575308067607349e-29,
        1.22933308981111328932e-36,
        2.73370053816464559624e-44,
        2.16741683877804819444e-51,
    ];
    const TWO24: f64 = 1.67772160000000000000e+07;
    const TWON24: f64 = 5.96046447753906250000e-08;
    let jk: i32 = 4; // init_jk[2]
    let jp = jk;
    let jx = nx as i32 - 1;
    let mut jv = (e0 - 3) / 24;
    if jv < 0 {
        jv = 0;
    }
    let mut q0 = e0 - 24 * (jv + 1);
    let mut f = [0.0f64; 20];
    let mut q = [0.0f64; 20];
    let mut fq = [0.0f64; 20];
    let mut iq = [0i32; 20];
    let mut j = jv - jx;
    let m = jx + jk;
    for i in 0..=m {
        f[i as usize] = if j < 0 {
            0.0
        } else {
            TWO_OVER_PI[j as usize] as f64
        };
        j += 1;
    }
    for i in 0..=jk {
        let mut fw = 0.0;
        for j in 0..=jx {
            fw += x[j as usize] * f[(jx + i - j) as usize];
        }
        q[i as usize] = fw;
    }
    let mut jz = jk;
    let (mut z, mut n, mut ih);
    loop {
        // Distill q[] into iq[] reversingly.
        let mut i = 0usize;
        let mut j = jz;
        z = q[jz as usize];
        while j > 0 {
            let fw = ((TWON24 * z) as i32) as f64;
            iq[i] = (z - TWO24 * fw) as i32;
            z = q[(j - 1) as usize] + fw;
            i += 1;
            j -= 1;
        }
        z = libm::scalbn(z, q0);
        z -= 8.0 * (z * 0.125).floor();
        n = z as i32;
        z -= n as f64;
        ih = 0;
        let last = (jz - 1) as usize;
        if q0 > 0 {
            let i = iq[last] >> (24 - q0);
            n += i;
            iq[last] -= i << (24 - q0);
            ih = iq[last] >> (23 - q0);
        } else if q0 == 0 {
            ih = iq[last] >> 23;
        } else if z >= 0.5 {
            ih = 2;
        }
        if ih > 0 {
            n += 1;
            let mut carry = 0;
            for i in 0..jz as usize {
                let j = iq[i];
                if carry == 0 {
                    if j != 0 {
                        carry = 1;
                        iq[i] = 0x1000000 - j;
                    }
                } else {
                    iq[i] = 0xFFFFFF - j;
                }
            }
            if q0 > 0 {
                match q0 {
                    1 => iq[last] &= 0x7FFFFF,
                    2 => iq[last] &= 0x3FFFFF,
                    _ => {}
                }
            }
            if ih == 2 {
                z = 1.0 - z;
                if carry != 0 {
                    z -= libm::scalbn(1.0, q0);
                }
            }
        }
        if z == 0.0 {
            let mut j = 0;
            let mut i = jz - 1;
            while i >= jk {
                j |= iq[i as usize];
                i -= 1;
            }
            if j == 0 {
                // Recompute with more terms.
                let mut k = 1;
                while jk >= k && iq[(jk - k) as usize] == 0 {
                    k += 1;
                }
                for i in jz + 1..=jz + k {
                    f[(jx + i) as usize] = TWO_OVER_PI[(jv + i) as usize] as f64;
                    let mut fw = 0.0;
                    for j in 0..=jx {
                        fw += x[j as usize] * f[(jx + i - j) as usize];
                    }
                    q[i as usize] = fw;
                }
                jz += k;
                continue;
            }
        }
        break;
    }
    // Chop off zero terms.
    if z == 0.0 {
        jz -= 1;
        q0 -= 24;
        while iq[jz as usize] == 0 {
            jz -= 1;
            q0 -= 24;
        }
    } else {
        z = libm::scalbn(z, -q0);
        if z >= TWO24 {
            let fw = ((TWON24 * z) as i32) as f64;
            iq[jz as usize] = (z - TWO24 * fw) as i32;
            jz += 1;
            q0 += 24;
            iq[jz as usize] = fw as i32;
        } else {
            iq[jz as usize] = z as i32;
        }
    }
    let mut fw = libm::scalbn(1.0, q0);
    let mut i = jz;
    while i >= 0 {
        q[i as usize] = fw * iq[i as usize] as f64;
        fw *= TWON24;
        i -= 1;
    }
    let mut i = jz;
    while i >= 0 {
        let mut fw = 0.0;
        let mut k = 0;
        while k <= jp && k <= jz - i {
            fw += PIO2[k as usize] * q[(i + k) as usize];
            k += 1;
        }
        fq[(jz - i) as usize] = fw;
        i -= 1;
    }
    // prec 2: compress fq[] into y[].
    let mut fw = 0.0;
    let mut i = jz;
    while i >= 0 {
        fw += fq[i as usize];
        i -= 1;
    }
    y[0] = if ih == 0 { fw } else { -fw };
    let mut fw = fq[0] - fw;
    for i in 1..=jz {
        fw += fq[i as usize];
    }
    y[1] = if ih == 0 { fw } else { -fw };
    n & 7
}

/// `__ieee754_rem_pio2`: x = n·π/2 + (y[0] + y[1]).
fn rem_pio2(x: f64, y: &mut [f64; 2]) -> i32 {
    const HALF: f64 = 5.00000000000000000000e-01;
    const TWO24: f64 = 1.67772160000000000000e+07;
    const INVPIO2: f64 = 6.36619772367581382433e-01;
    const PIO2_1: f64 = 1.57079632673412561417e+00;
    const PIO2_1T: f64 = 6.07710050650619224932e-11;
    const PIO2_2: f64 = 6.07710050630396597660e-11;
    const PIO2_2T: f64 = 2.02226624879595063154e-21;
    const PIO2_3: f64 = 2.02226624871116645580e-21;
    const PIO2_3T: f64 = 8.47842766036889956997e-32;
    let hx = high(x);
    let ix = hx & 0x7FFFFFFF;
    if ix <= 0x3FE921FB {
        y[0] = x;
        y[1] = 0.0;
        return 0;
    }
    if ix < 0x4002D97C {
        if hx > 0 {
            let mut z = x - PIO2_1;
            if ix != 0x3FF921FB {
                y[0] = z - PIO2_1T;
                y[1] = (z - y[0]) - PIO2_1T;
            } else {
                z -= PIO2_2;
                y[0] = z - PIO2_2T;
                y[1] = (z - y[0]) - PIO2_2T;
            }
            return 1;
        }
        let mut z = x + PIO2_1;
        if ix != 0x3FF921FB {
            y[0] = z + PIO2_1T;
            y[1] = (z - y[0]) + PIO2_1T;
        } else {
            z += PIO2_2;
            y[0] = z + PIO2_2T;
            y[1] = (z - y[0]) + PIO2_2T;
        }
        return -1;
    }
    if ix <= 0x413921FB {
        let t = x.abs();
        let n = (t * INVPIO2 + HALF) as i32;
        let f_n = n as f64;
        let mut r = t - f_n * PIO2_1;
        let mut w = f_n * PIO2_1T;
        if n < 32 && ix != NPIO2_HW[(n - 1) as usize] {
            y[0] = r - w;
        } else {
            let j = ix >> 20;
            y[0] = r - w;
            let mut i = j - ((high(y[0]) as u32 >> 20) & 0x7FF) as i32;
            if i > 16 {
                let t = r;
                w = f_n * PIO2_2;
                r = t - w;
                w = f_n * PIO2_2T - ((t - r) - w);
                y[0] = r - w;
                i = j - ((high(y[0]) as u32 >> 20) & 0x7FF) as i32;
                if i > 49 {
                    let t = r;
                    w = f_n * PIO2_3;
                    r = t - w;
                    w = f_n * PIO2_3T - ((t - r) - w);
                    y[0] = r - w;
                }
            }
        }
        y[1] = (r - y[0]) - w;
        if hx < 0 {
            y[0] = -y[0];
            y[1] = -y[1];
            return -n;
        }
        return n;
    }
    if ix >= 0x7FF00000 {
        // `x - x`: NaN (JS has one NaN).
        y[0] = f64::NAN;
        y[1] = f64::NAN;
        return 0;
    }
    // z = scalbn(|x|, ilogb(x) - 23), from the words of x.
    let e0 = (ix >> 20) - 1046;
    let mut z = words(ix - ((e0 as u32) << 20) as i32, low(x));
    let mut tx = [0.0f64; 3];
    for slot in tx.iter_mut().take(2) {
        *slot = (z as i32) as f64;
        z = (z - *slot) * TWO24;
    }
    tx[2] = z;
    let mut nx = 3;
    while tx[nx - 1] == 0.0 {
        nx -= 1;
    }
    let n = kernel_rem_pio2(&tx, y, e0, nx);
    if hx < 0 {
        y[0] = -y[0];
        y[1] = -y[1];
        return -n;
    }
    n
}

pub fn cos(x: f64) -> f64 {
    let ix = high(x) & 0x7FFFFFFF;
    if ix <= 0x3FE921FB {
        return kernel_cos(x, 0.0);
    }
    if ix >= 0x7FF00000 {
        // `x - x`: sin/cos of Inf or NaN is NaN.
        return f64::NAN;
    }
    let mut y = [0.0; 2];
    match rem_pio2(x, &mut y) & 3 {
        0 => kernel_cos(y[0], y[1]),
        1 => -kernel_sin(y[0], y[1], 1),
        2 => -kernel_cos(y[0], y[1]),
        _ => kernel_sin(y[0], y[1], 1),
    }
}

pub fn sin(x: f64) -> f64 {
    let ix = high(x) & 0x7FFFFFFF;
    if ix <= 0x3FE921FB {
        return kernel_sin(x, 0.0, 0);
    }
    if ix >= 0x7FF00000 {
        // `x - x`: sin/cos of Inf or NaN is NaN.
        return f64::NAN;
    }
    let mut y = [0.0; 2];
    match rem_pio2(x, &mut y) & 3 {
        0 => kernel_sin(y[0], y[1], 1),
        1 => kernel_cos(y[0], y[1]),
        2 => -kernel_sin(y[0], y[1], 1),
        _ => -kernel_cos(y[0], y[1]),
    }
}

pub fn exp(x: f64) -> f64 {
    const ONE: f64 = 1.0;
    const HALF: [f64; 2] = [0.5, -0.5];
    const O_THRESHOLD: f64 = 7.09782712893383973096e+02;
    const U_THRESHOLD: f64 = -7.45133219101941108420e+02;
    const LN2_HI: [f64; 2] = [6.93147180369123816490e-01, -6.93147180369123816490e-01];
    const LN2_LO: [f64; 2] = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
    const INVLN2: f64 = 1.44269504088896338700e+00;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const E: f64 = 2.718281828459045;
    const HUGE: f64 = 1.0e+300;
    const TWOM1000: f64 = 9.33263618503218878990e-302;
    const TWO1023: f64 = 8.988465674311579539e307;
    let mut x = x;
    let (mut hi, mut lo, mut k) = (0.0, 0.0, 0i32);
    let hx = high(x) as u32;
    let xsb = ((hx >> 31) & 1) as usize;
    let hx = hx & 0x7FFFFFFF;
    if hx >= 0x40862E42 {
        if hx >= 0x7FF00000 {
            return if ((hx & 0xFFFFF) | low(x)) != 0 {
                x + x
            } else if xsb == 0 {
                x
            } else {
                0.0
            };
        }
        if x > O_THRESHOLD {
            return HUGE * HUGE;
        }
        if x < U_THRESHOLD {
            return TWOM1000 * TWOM1000;
        }
    }
    if hx > 0x3FD62E42 {
        if hx < 0x3FF0A2B2 {
            // V8 special-cases exp(1) so it returns exactly Math.E.
            if x == 1.0 {
                return E;
            }
            hi = x - LN2_HI[xsb];
            lo = LN2_LO[xsb];
            k = 1 - xsb as i32 - xsb as i32;
        } else {
            k = (INVLN2 * x + HALF[xsb]) as i32;
            let t = k as f64;
            hi = x - t * LN2_HI[0];
            lo = t * LN2_LO[0];
        }
        x = hi - lo;
    } else if hx < 0x3E300000 {
        if HUGE + x > ONE {
            return ONE + x;
        }
    } else {
        k = 0;
    }
    let t = x * x;
    let twopk = if k >= -1021 {
        words(0x3FF00000_i32.wrapping_add(((k as u32) << 20) as i32), 0)
    } else {
        words(
            0x3FF00000_i32.wrapping_add((((k + 1000) as u32) << 20) as i32),
            0,
        )
    };
    let c = x - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    if k == 0 {
        return ONE - ((x * c) / (c - 2.0) - x);
    }
    let y = ONE - ((lo - (x * c) / (2.0 - c)) - hi);
    if k >= -1021 {
        if k == 1024 {
            return y * 2.0 * TWO1023;
        }
        y * twopk
    } else {
        y * twopk * TWOM1000
    }
}

/// `__ieee754_acos` (fdlibm 5.3 `e_acos.c`), V8's `Math.acos`.
pub fn acos(x: f64) -> f64 {
    const ONE: f64 = 1.00000000000000000000e+00;
    const PI: f64 = 3.14159265358979311600e+00;
    const PIO2_HI: f64 = 1.57079632679489655800e+00;
    const PIO2_LO: f64 = 6.12323399573676603587e-17;
    const PS0: f64 = 1.66666666666666657415e-01;
    const PS1: f64 = -3.25565818622400915405e-01;
    const PS2: f64 = 2.01212532134862925881e-01;
    const PS3: f64 = -4.00555345006794114027e-02;
    const PS4: f64 = 7.91534994289814532176e-04;
    const PS5: f64 = 3.47933107596021167570e-05;
    const QS1: f64 = -2.40339491173441421878e+00;
    const QS2: f64 = 2.02094576023350569471e+00;
    const QS3: f64 = -6.88283971605453293030e-01;
    const QS4: f64 = 7.70381505559019352791e-02;
    let hx = high(x);
    let ix = hx & 0x7fffffff;
    if ix >= 0x3ff00000 {
        // |x| >= 1
        if ((ix - 0x3ff00000) as u32 | low(x)) == 0 {
            // |x| == 1
            return if hx > 0 { 0.0 } else { PI + 2.0 * PIO2_LO };
        }
        return f64::NAN; // acos(|x| > 1) is NaN, and JavaScript has one NaN
    }
    if ix < 0x3fe00000 {
        // |x| < 0.5
        if ix <= 0x3c600000 {
            return PIO2_HI + PIO2_LO; // |x| < 2**-57
        }
        let z = x * x;
        let p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
        let q = ONE + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
        let r = p / q;
        PIO2_HI - (x - (PIO2_LO - x * r))
    } else if hx < 0 {
        // x < -0.5
        let z = (ONE + x) * 0.5;
        let p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
        let q = ONE + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
        let s = z.sqrt();
        let r = p / q;
        let w = r * s - PIO2_LO;
        PI - 2.0 * (s + w)
    } else {
        // x > 0.5
        let z = (ONE - x) * 0.5;
        let s = z.sqrt();
        let df = words(high(s), 0);
        let c = (z - df * df) / (s + df);
        let p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
        let q = ONE + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
        let r = p / q;
        let w = r * s + c;
        2.0 * (df + w)
    }
}

/// `__kernel_tan(x, y, k)`: tan on [-pi/4, pi/4] with tail `y`; `iy` is 1 for
/// tan and -1 for -1/tan.
fn kernel_tan(mut x: f64, mut y: f64, iy: i32) -> f64 {
    const T: [f64; 13] = [
        3.33333333333334091986e-01,
        1.33333333333201242699e-01,
        5.39682539762260521377e-02,
        2.18694882948595424599e-02,
        8.86323982359930005737e-03,
        3.59207910759131235356e-03,
        1.45620945432529025516e-03,
        5.88041240820264096874e-04,
        2.46463134818469906812e-04,
        7.81794442939557092300e-05,
        7.14072491382608190305e-05,
        -1.85586374855275456654e-05,
        2.59073051863633712884e-05,
    ];
    const ONE: f64 = 1.00000000000000000000e+00;
    const PIO4: f64 = 7.85398163397448278999e-01;
    const PIO4LO: f64 = 3.06161699786838301793e-17;
    let hx = high(x);
    let ix = hx & 0x7FFFFFFF;
    if ix < 0x3E300000 && x as i32 == 0 {
        // |x| < 2**-28.
        if ix == 0 && low(x) == 0 && iy == -1 {
            return ONE / x.abs();
        }
        if iy == 1 {
            return x;
        }
        // Compute -1 / (x+y) carefully.
        let w = x + y;
        let z = words(high(w), 0);
        let v = y - (z - x);
        let a = -ONE / w;
        let t = words(high(a), 0);
        let s = ONE + t * z;
        return t + a * (s + t * v);
    }
    if ix >= 0x3FE59428 {
        // |x| >= 0.6744.
        if hx < 0 {
            x = -x;
            y = -y;
        }
        let z = PIO4 - x;
        let w = PIO4LO - y;
        x = z + w;
        y = 0.0;
    }
    let z = x * x;
    let w = z * z;
    // x^5 (T1 + x^2 T2 + ...) split into odd and even powers of x^4.
    let r = T[1] + w * (T[3] + w * (T[5] + w * (T[7] + w * (T[9] + w * T[11]))));
    let v = z * (T[2] + w * (T[4] + w * (T[6] + w * (T[8] + w * (T[10] + w * T[12])))));
    let s = z * x;
    let mut r = y + z * (s * (r + v) + y);
    r += T[0] * s;
    let w = x + r;
    if ix >= 0x3FE59428 {
        let v = iy as f64;
        return (1 - ((hx >> 30) & 2)) as f64 * (v - 2.0 * (x - (w * w / (w + v) - r)));
    }
    if iy == 1 {
        return w;
    }
    // Compute -1.0 / (x+r) accurately.
    let z = words(high(w), 0);
    let v = r - (z - x);
    let a = -1.0 / w;
    let t = words(high(a), 0);
    let s = 1.0 + t * z;
    t + a * (s + t * v)
}

pub fn tan(x: f64) -> f64 {
    let ix = high(x) & 0x7FFFFFFF;
    if ix <= 0x3FE921FB {
        return kernel_tan(x, 0.0, 1);
    }
    if ix >= 0x7FF00000 {
        // `x - x`: tan of Inf or NaN is NaN.
        return f64::NAN;
    }
    let mut y = [0.0; 2];
    let n = rem_pio2(x, &mut y);
    kernel_tan(y[0], y[1], 1 - ((n & 1) << 1))
}

/// `__ieee754_asin` (fdlibm 5.3 `e_asin.c`), V8's `Math.asin`.
pub fn asin(x: f64) -> f64 {
    const ONE: f64 = 1.00000000000000000000e+00;
    const HUGE: f64 = 1.000e+300;
    const PIO2_HI: f64 = 1.57079632679489655800e+00;
    const PIO2_LO: f64 = 6.12323399573676603587e-17;
    const PIO4_HI: f64 = 7.85398163397448278999e-01;
    const PS0: f64 = 1.66666666666666657415e-01;
    const PS1: f64 = -3.25565818622400915405e-01;
    const PS2: f64 = 2.01212532134862925881e-01;
    const PS3: f64 = -4.00555345006794114027e-02;
    const PS4: f64 = 7.91534994289814532176e-04;
    const PS5: f64 = 3.47933107596021167570e-05;
    const QS1: f64 = -2.40339491173441421878e+00;
    const QS2: f64 = 2.02094576023350569471e+00;
    const QS3: f64 = -6.88283971605453293030e-01;
    const QS4: f64 = 7.70381505559019352791e-02;
    let hx = high(x);
    let ix = hx & 0x7fffffff;
    if ix >= 0x3ff00000 {
        // |x| >= 1
        if ((ix - 0x3ff00000) as u32 | low(x)) == 0 {
            // asin(±1) = ±pi/2
            return x * PIO2_HI + x * PIO2_LO;
        }
        return f64::NAN; // asin(|x| > 1) is NaN, and JavaScript has one NaN
    }
    if ix < 0x3fe00000 {
        // |x| < 0.5
        if ix < 0x3e400000 && HUGE + x > ONE {
            return x; // |x| < 2**-27
        }
        let t = x * x;
        let p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
        let q = ONE + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
        let w = p / q;
        return x + x * w;
    }
    // 1 > |x| >= 0.5
    let w = ONE - x.abs();
    let t = w * 0.5;
    let p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
    let q = ONE + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
    let s = t.sqrt();
    let t = if ix >= 0x3FEF3333 {
        // |x| > 0.975
        let w = p / q;
        PIO2_HI - (2.0 * (s + s * w) - PIO2_LO)
    } else {
        let w = words(high(s), 0);
        let c = (t - w * w) / (s + w);
        let r = p / q;
        let p = 2.0 * s * r - (PIO2_LO - 2.0 * c);
        let q = PIO4_HI - 2.0 * w;
        PIO4_HI - (p - q)
    };
    if hx > 0 { t } else { -t }
}

/// `atan` (fdlibm 5.3 `s_atan.c`), V8's `Math.atan`.
pub fn atan(x: f64) -> f64 {
    const ATANHI: [f64; 4] = [
        4.63647609000806093515e-01,
        7.85398163397448278999e-01,
        9.82793723247329054082e-01,
        1.57079632679489655800e+00,
    ];
    const ATANLO: [f64; 4] = [
        2.26987774529616870924e-17,
        3.06161699786838301793e-17,
        1.39033110312309984516e-17,
        6.12323399573676603587e-17,
    ];
    const AT: [f64; 11] = [
        3.33333333333329318027e-01,
        -1.99999999998764832476e-01,
        1.42857142725034663711e-01,
        -1.11111104054623557880e-01,
        9.09088713343650656196e-02,
        -7.69187620504482999495e-02,
        6.66107313738753120669e-02,
        -5.83357013379057348645e-02,
        4.97687799461593236017e-02,
        -3.65315727442169155270e-02,
        1.62858201153657823623e-02,
    ];
    const ONE: f64 = 1.0;
    const HUGE: f64 = 1.0e300;
    let hx = high(x);
    let ix = hx & 0x7fffffff;
    let mut x = x;
    let id: i32;
    if ix >= 0x44100000 {
        // |x| >= 2**66
        if ix > 0x7ff00000 || (ix == 0x7ff00000 && low(x) != 0) {
            return f64::NAN;
        }
        return if hx > 0 {
            ATANHI[3] + ATANLO[3]
        } else {
            -ATANHI[3] - ATANLO[3]
        };
    }
    if ix < 0x3fdc0000 {
        // |x| < 0.4375
        if ix < 0x3e400000 && HUGE + x > ONE {
            return x; // |x| < 2**-27
        }
        id = -1;
    } else {
        x = x.abs();
        if ix < 0x3ff30000 {
            // |x| < 1.1875
            if ix < 0x3fe60000 {
                // 7/16 <= |x| < 11/16
                id = 0;
                x = (2.0 * x - ONE) / (2.0 + x);
            } else {
                // 11/16 <= |x| < 19/16
                id = 1;
                x = (x - ONE) / (x + ONE);
            }
        } else if ix < 0x40038000 {
            // |x| < 2.4375
            id = 2;
            x = (x - 1.5) / (ONE + 1.5 * x);
        } else {
            // 2.4375 <= |x| < 2**66
            id = 3;
            x = -1.0 / x;
        }
    }
    let z = x * x;
    let w = z * z;
    let s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    let s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    if id < 0 {
        return x - x * (s1 + s2);
    }
    let id = id as usize;
    let z = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
    if hx < 0 { -z } else { z }
}

/// `__ieee754_atan2` (fdlibm `e_atan2.c` as V8 ships it, with FreeBSD's
/// `m &= 1` for |y/x| beyond 2**60), V8's `Math.atan2`.
pub fn atan2(y: f64, x: f64) -> f64 {
    const TINY: f64 = 1.0e-300;
    const PI_O_4: f64 = 7.8539816339744827900E-01;
    const PI_O_2: f64 = 1.5707963267948965580E+00;
    const PI: f64 = 3.1415926535897931160E+00;
    const PI_LO: f64 = 1.2246467991473531772E-16;
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    let hx = high(x);
    let ix = hx & 0x7fffffff;
    let lx = low(x);
    let hy = high(y);
    let iy = hy & 0x7fffffff;
    let ly = low(y);
    if (hx.wrapping_sub(0x3ff00000) as u32 | lx) == 0 {
        return atan(y); // x = 1.0
    }
    let mut m = ((hy >> 31) & 1) | ((hx >> 30) & 2); // 2 * sign(x) + sign(y)
    if (iy as u32 | ly) == 0 {
        // y = 0
        return match m {
            0 | 1 => y,
            2 => PI + TINY,
            _ => -PI - TINY,
        };
    }
    if (ix as u32 | lx) == 0 {
        // x = 0
        return if hy < 0 {
            -PI_O_2 - TINY
        } else {
            PI_O_2 + TINY
        };
    }
    if ix == 0x7ff00000 {
        // x is infinite
        return if iy == 0x7ff00000 {
            match m {
                0 => PI_O_4 + TINY,
                1 => -PI_O_4 - TINY,
                2 => 3.0 * PI_O_4 + TINY,
                _ => -3.0 * PI_O_4 - TINY,
            }
        } else {
            match m {
                0 => 0.0,
                1 => -0.0,
                2 => PI + TINY,
                _ => -PI - TINY,
            }
        };
    }
    if iy == 0x7ff00000 {
        // y is infinite
        return if hy < 0 {
            -PI_O_2 - TINY
        } else {
            PI_O_2 + TINY
        };
    }
    let k = (iy - ix) >> 20;
    let z = if k > 60 {
        // |y/x| > 2**60
        m &= 1;
        PI_O_2 + 0.5 * PI_LO
    } else if hx < 0 && k < -60 {
        0.0 // 0 > |y|/x > -2**-60
    } else {
        atan((y / x).abs())
    };
    match m {
        0 => z,
        1 => -z,
        2 => PI - (z - PI_LO),
        _ => (z - PI_LO) - PI,
    }
}

fn with_low(x: f64, low: u32) -> f64 {
    words(high(x), low)
}
fn with_high(x: f64, high: i32) -> f64 {
    words(high, low(x))
}

/// `scalbn` (fdlibm `s_scalbn.c`): `x × 2ⁿ`, one rounding for a subnormal result.
fn scalbn(x: f64, n: i32) -> f64 {
    const TWO54: f64 = 1.80143985094819840000e+16;
    const TWOM54: f64 = 5.55111512312578270212e-17;
    const HUGE: f64 = 1.0e+300;
    const TINY: f64 = 1.0e-300;
    let mut x = x;
    let mut hx = high(x);
    let lx = low(x);
    let mut k = (hx & 0x7ff00000) >> 20;
    if k == 0 {
        if (lx | (hx as u32 & 0x7fffffff)) == 0 {
            return x;
        }
        x *= TWO54;
        hx = high(x);
        k = ((hx & 0x7ff00000) >> 20) - 54;
        if n < -50000 {
            return TINY * x;
        }
    }
    if k == 0x7ff {
        return x + x;
    }
    k += n;
    if k > 0x7fe {
        return HUGE * HUGE.copysign(x);
    }
    let mantissa = (hx as u32 & 0x800fffff) as i32;
    if k > 0 {
        return words(mantissa | (k << 20), low(x));
    }
    if k <= -54 {
        return if n > 50000 {
            HUGE * HUGE.copysign(x)
        } else {
            TINY * TINY.copysign(x)
        };
    }
    k += 54;
    words(mantissa | (k << 20), low(x)) * TWOM54
}

/// `Math.pow` and `**`: V8's `ieee754::pow`, fdlibm 5.3's `e_pow.c` (not
/// glibc's correctly rounded routine: the two differ in the last bit for
/// about one argument in ten). Like ECMAScript, `(±1) ** ±∞` is NaN.
pub fn pow(x: f64, y: f64) -> f64 {
    const BP: [f64; 2] = [1.0, 1.5];
    const DP_H: [f64; 2] = [0.0, 5.84962487220764160156e-01];
    const DP_L: [f64; 2] = [0.0, 1.35003920212974897128e-08];
    const ZERO: f64 = 0.0;
    const ONE: f64 = 1.0;
    const TWO: f64 = 2.0;
    const TWO53: f64 = 9007199254740992.0;
    const HUGE: f64 = 1.0e300;
    const TINY: f64 = 1.0e-300;
    const L1: f64 = 5.99999999999994648725e-01;
    const L2: f64 = 4.28571428578550184252e-01;
    const L3: f64 = 3.33333329818377432918e-01;
    const L4: f64 = 2.72728123808534006489e-01;
    const L5: f64 = 2.30660745775561754067e-01;
    const L6: f64 = 2.06975017800338417784e-01;
    const P1: f64 = 1.66666666666666019037e-01;
    const P2: f64 = -2.77777777770155933842e-03;
    const P3: f64 = 6.61375632143793436117e-05;
    const P4: f64 = -1.65339022054652515390e-06;
    const P5: f64 = 4.13813679705723846039e-08;
    const LG2: f64 = 6.93147180559945286227e-01;
    const LG2_H: f64 = 6.93147182464599609375e-01;
    const LG2_L: f64 = -1.90465429995776804525e-09;
    const OVT: f64 = 8.0085662595372944372e-17;
    const CP: f64 = 9.61796693925975554329e-01;
    const CP_H: f64 = 9.61796700954437255859e-01;
    const CP_L: f64 = -7.02846165095275826516e-09;
    const IVLN2: f64 = 1.44269504088896338700e+00;
    const IVLN2_H: f64 = 1.44269502162933349609e+00;
    const IVLN2_L: f64 = 1.92596299112661746887e-08;

    let hx = high(x);
    let lx = low(x);
    let hy = high(y);
    let ly = low(y);
    let mut ix = hx & 0x7fffffff;
    let iy = hy & 0x7fffffff;

    // y == 0: x ** 0 is 1.
    if (iy as u32 | ly) == 0 {
        return ONE;
    }
    // NaN in either place.
    if ix > 0x7ff00000
        || (ix == 0x7ff00000 && lx != 0)
        || iy > 0x7ff00000
        || (iy == 0x7ff00000 && ly != 0)
    {
        return x + y;
    }

    // For x < 0: 0 when y is not an integer, 1 when odd, 2 when even.
    let mut yisint = 0;
    if hx < 0 {
        if iy >= 0x43400000 {
            yisint = 2;
        } else if iy >= 0x3ff00000 {
            let k = (iy >> 20) - 0x3ff;
            if k > 20 {
                let j = ly >> (52 - k);
                if (j << (52 - k)) == ly {
                    yisint = 2 - (j & 1) as i32;
                }
            } else if ly == 0 {
                let j = iy >> (20 - k);
                if (j << (20 - k)) == iy {
                    yisint = 2 - (j & 1);
                }
            }
        }
    }

    // Special values of y.
    if ly == 0 {
        if iy == 0x7ff00000 {
            // y is ±∞.
            return if ((ix - 0x3ff00000) as u32 | lx) == 0 {
                f64::NAN // (±1) ** ±∞ is NaN (fdlibm's `y - y`).
            } else if ix >= 0x3ff00000 {
                if hy >= 0 { y } else { ZERO }
            } else if hy < 0 {
                -y
            } else {
                ZERO
            };
        }
        if iy == 0x3ff00000 {
            // y is ±1.
            return if hy < 0 { ONE / x } else { x };
        }
        if hy == 0x40000000 {
            return x * x; // y is 2.
        }
        if hy == 0x3fe00000 && hx >= 0 {
            return x.sqrt(); // y is 0.5 and x ≥ +0.
        }
    }

    let mut ax = x.abs();
    // Special values of x: ±0, ±∞, ±1.
    if lx == 0 && (ix == 0x7ff00000 || ix == 0 || ix == 0x3ff00000) {
        let mut z = ax;
        if hy < 0 {
            z = ONE / z;
        }
        if hx < 0 {
            if ((ix - 0x3ff00000) | yisint) == 0 {
                z = f64::NAN; // (-1) ** non-integer.
            } else if yisint == 1 {
                z = -z;
            }
        }
        return z;
    }

    // 0 for a negative x, else 1.
    let n = (hx >> 31) + 1;
    // (x < 0) ** non-integer is NaN.
    if (n | yisint) == 0 {
        return f64::NAN;
    }
    // The sign of the result: negative for (-x) ** odd.
    let s = if (n | (yisint - 1)) == 0 { -ONE } else { ONE };

    let t1;
    let t2;
    if iy > 0x41e00000 {
        // |y| > 2³¹.
        if iy > 0x43f00000 {
            // |y| > 2⁶⁴: certain to overflow or underflow.
            if ix <= 0x3fefffff {
                return if hy < 0 { HUGE * HUGE } else { TINY * TINY };
            }
            if ix >= 0x3ff00000 {
                return if hy > 0 { HUGE * HUGE } else { TINY * TINY };
            }
        }
        // Over- or underflow unless x is close to one.
        if ix < 0x3fefffff {
            return if hy < 0 {
                s * HUGE * HUGE
            } else {
                s * TINY * TINY
            };
        }
        if ix > 0x3ff00000 {
            return if hy > 0 {
                s * HUGE * HUGE
            } else {
                s * TINY * TINY
            };
        }
        // |1 - x| ≤ 2⁻²⁰: log(x) by x - x²/2 + x³/3 - x⁴/4.
        let t = ax - ONE;
        let w = (t * t) * (0.5 - t * (0.3333333333333333333333 - t * 0.25));
        let u = IVLN2_H * t;
        let v = t * IVLN2_L - w * IVLN2;
        let first = with_low(u + v, 0);
        t1 = first;
        t2 = v - (first - u);
    } else {
        let mut n = 0;
        // Subnormal x.
        if ix < 0x00100000 {
            ax *= TWO53;
            n -= 53;
            ix = high(ax);
        }
        n += (ix >> 20) - 0x3ff;
        let j = ix & 0x000fffff;
        // The interval of x.
        ix = j | 0x3ff00000;
        let k;
        if j <= 0x3988E {
            k = 0; // |x| < √(3/2)
        } else if j < 0xBB67A {
            k = 1; // |x| < √3
        } else {
            k = 0;
            n += 1;
            ix -= 0x00100000;
        }
        ax = with_high(ax, ix);

        // ss = s_h + s_l = (x - 1)/(x + 1) or (x - 1.5)/(x + 1.5).
        let u = ax - BP[k];
        let v = ONE / (ax + BP[k]);
        let ss = u * v;
        let s_h = with_low(ss, 0);
        // t_h = ax + bp[k], high part.
        let t_h = words(
            ((ix >> 1) | 0x20000000) + 0x00080000 + ((k as i32) << 18),
            0,
        );
        let t_l = ax - (t_h - BP[k]);
        let s_l = v * ((u - s_h * t_h) - s_h * t_l);
        // log(ax).
        let mut s2 = ss * ss;
        let mut r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
        r += s_l * (s_h + ss);
        s2 = s_h * s_h;
        let t_h = with_low(3.0 + s2 + r, 0);
        let t_l = r - ((t_h - 3.0) - s2);
        // u + v = ss × (1 + ...).
        let u = s_h * t_h;
        let v = s_l * t_h + t_l * ss;
        // 2/(3 log 2) × (ss + ...).
        let p_h = with_low(u + v, 0);
        let p_l = v - (p_h - u);
        let z_h = CP_H * p_h;
        let z_l = CP_L * p_h + p_l * CP + DP_L[k];
        // log2(ax) = (ss + ..) × 2/(3 log 2) = n + dp_h + z_h + z_l.
        let t = n as f64;
        let first = with_low(((z_h + z_l) + DP_H[k]) + t, 0);
        t1 = first;
        t2 = z_l - (((first - t) - DP_H[k]) - z_h);
    }

    // (y1 + y2) × (t1 + t2), y split in two.
    let y1 = with_low(y, 0);
    let p_l = (y - y1) * t1 + y * t2;
    let mut p_h = y1 * t1;
    let z = p_l + p_h;
    let j = high(z);
    let i = low(z) as i32;
    if j >= 0x40900000 {
        // z ≥ 1024.
        if ((j - 0x40900000) | i) != 0 {
            return s * HUGE * HUGE; // overflow
        }
        if p_l + OVT > z - p_h {
            return s * HUGE * HUGE; // overflow
        }
    } else if (j & 0x7fffffff) >= 0x4090cc00 {
        // z ≤ -1075.
        if ((j as u32).wrapping_sub(0xc090cc00) as i32 | i) != 0 {
            return s * TINY * TINY; // underflow
        }
        if p_l <= z - p_h {
            return s * TINY * TINY; // underflow
        }
    }
    // 2 ** (p_h + p_l).
    let i = j & 0x7fffffff;
    let mut k = (i >> 20) - 0x3ff;
    let mut n = 0;
    if i > 0x3fe00000 {
        // |z| > 0.5: n = [z + 0.5].
        n = j.wrapping_add(0x00100000 >> (k + 1));
        k = ((n & 0x7fffffff) >> 20) - 0x3ff; // the new k for n
        let t = words(n & !(0x000fffff >> k), 0);
        n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
        if j < 0 {
            n = -n;
        }
        p_h -= t;
    }
    let t = with_low(p_l + p_h, 0);
    let u = t * LG2_H;
    let v = (p_l - (t - p_h)) * LG2 + t * LG2_L;
    let mut z = u + v;
    let w = v - (z - u);
    let t = z * z;
    let t1 = z - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    let r = (z * t1) / ((t1 - TWO) - (w + z * w));
    z = ONE - (r - z);
    let j = high(z).wrapping_add(((n as u32) << 20) as i32);
    if (j >> 20) <= 0 {
        z = scalbn(z, n); // subnormal output
    } else {
        z = with_high(z, high(z).wrapping_add(((n as u32) << 20) as i32));
    }
    s * z
}

/// `Math.cbrt`: V8's `ieee754::cbrt`, FreeBSD's `s_cbrt.c` — a 23-bit
/// polynomial estimate rounded to 23 bits, then one Newton step.
pub fn cbrt(x: f64) -> f64 {
    const B1: u32 = 715094163;
    const B2: u32 = 696219795;
    const P0: f64 = 1.87595182427177009643;
    const P1: f64 = -1.88497979543377169875;
    const P2: f64 = 1.621429720105354466140;
    const P3: f64 = -0.758397934778766047437;
    const P4: f64 = 0.145996192886612446982;
    let mut hx = high(x) as u32;
    let lx = low(x);
    let sign = hx & 0x80000000;
    hx ^= sign;
    if hx >= 0x7ff00000 {
        return x + x; // NaN and ±∞ are themselves.
    }
    let mut t;
    if hx < 0x00100000 {
        // Zero or subnormal.
        if (hx | lx) == 0 {
            return x;
        }
        t = words(0x43500000, 0) * x; // 2⁵⁴ × x
        let high_t = high(t) as u32;
        t = words((sign | ((high_t & 0x7fffffff) / 3 + B2)) as i32, 0);
    } else {
        t = words((sign | (hx / 3 + B1)) as i32, 0);
    }
    // cbrt to 23 bits: t × P(t³/x).
    let r = (t * t) * (t / x);
    t *= (P0 + r * (P1 + r * P2)) + ((r * r) * r) * (P3 + r * P4);
    // Round t away from zero to 23 bits.
    t = f64::from_bits((t.to_bits().wrapping_add(0x80000000)) & 0xffffffffc0000000);
    // One Newton step to 53 bits.
    let s = t * t;
    let r = x / s;
    let w = t + t;
    let r = (r - t) / (w + r);
    t + t * r
}
