//! `Math.sin`, `Math.cos`, `Math.tan`, `Math.exp` and `Math.acos` exactly as V8 computes them: a
//! line-for-line port of V8 12.4's `src/base/ieee754.cc` (fdlibm 5.3, which
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
