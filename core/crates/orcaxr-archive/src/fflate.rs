//! The browser's own compressor, ported exactly: fflate 0.8.3's `deflateSync`
//! and `zipSync` as `writeDeterministicZip` (web/src/project/serialization/
//! deterministicZip.ts) calls them. The native writer ([`crate::write`])
//! produces equivalent archives whose compressed bytes differ; an export that
//! must be the browser's file byte for byte (Export all objects as STLs, the
//! plated 3MF) writes through this module instead.
//!
//! Everything but the hash width is integer arithmetic over the input, so
//! every host writes the same bytes. The quirks are the browser's and are
//! kept: the hash width is `Math.ceil(clamp(ln n, 8, 13) * 1.5)` bits (the
//! logarithm of an integer length is never within rounding of a width's
//! threshold, so any correctly rounded `ln` agrees), blocks end at 7,000
//! matches or 24,576 symbols unless fewer than 424 bytes remain, Huffman trees
//! are built with UZIP.js's two-queue merge and length-limited by its debt
//! walk, and a block is stored when that is no longer than either coding.
//! fflate writes into zero-filled typed arrays, so every write ORs into or
//! replaces bytes of a buffer sized as fflate sizes it, and a write past its
//! end is dropped as a typed array drops it.
use crate::{Error, Result, ZipLimits, validate_package_path};
use std::io::Write;

const FLEB: [u8; 32] = [
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0,
];
const FDEB: [u8; 32] = [
    0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13,
    13, 0, 0,
];
const CLIM: [usize; 19] = [
    16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
];
/// `(nice << 13) | chain` per level.
const DEO: [u32; 9] = [
    65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632,
];

struct Tables {
    revfl: Vec<u32>,
    revfd: Vec<u32>,
    rev: Vec<u16>,
    flt: [u8; 288],
    fdt: [u8; 32],
    flm: Vec<u16>,
    fdm: Vec<u16>,
}

/// `freb`: the base of each code and, per value, `(value - base) << 5 | code`.
fn freb(eb: &[u8; 32], mut start: u32) -> (Vec<u16>, Vec<u32>) {
    let mut b = vec![0u16; 31];
    for i in 0..31 {
        // `eb[-1]` is undefined and `1 << undefined` is 1.
        start += 1 << if i == 0 { 0 } else { eb[i - 1] };
        b[i] = start as u16;
    }
    let mut r = vec![0u32; b[30] as usize];
    for i in 1..30 {
        for j in b[i]..b[i + 1] {
            r[j as usize] = ((u32::from(j) - u32::from(b[i])) << 5) | i as u32;
        }
    }
    (b, r)
}

/// `hMap(cd, mb, 0)`: canonical codes, bit-reversed for LSB-first output.
fn h_map(cd: &[u8], mb: usize, rev: &[u16]) -> Vec<u16> {
    let mut l = vec![0u16; mb];
    for &length in cd {
        if length != 0
            && let Some(count) = l.get_mut(usize::from(length) - 1)
        {
            *count = count.wrapping_add(1);
        }
    }
    let mut le = vec![0u16; mb];
    for i in 1..mb {
        le[i] = le[i - 1].wrapping_add(l[i - 1]) << 1;
    }
    let mut co = vec![0u16; cd.len()];
    for (i, &length) in cd.iter().enumerate() {
        if length != 0 {
            let slot = usize::from(length) - 1;
            let start = le.get(slot).copied().unwrap_or(0);
            if let Some(next) = le.get_mut(slot) {
                *next = next.wrapping_add(1);
            }
            let reversed = rev.get(usize::from(start)).copied().unwrap_or(0);
            co[i] = ((u32::from(reversed)) >> (15 - u32::from(length))) as u16;
        }
    }
    co
}

fn tables() -> &'static Tables {
    static TABLES: std::sync::OnceLock<Tables> = std::sync::OnceLock::new();
    TABLES.get_or_init(|| {
        let (_fl, mut revfl) = freb(&FLEB, 2);
        // fflate's fix-up: length 258 is code 28 with no extra bits.
        revfl[258] = 28;
        let (_fd, revfd) = freb(&FDEB, 0);
        let mut rev = vec![0u16; 32768];
        for (i, slot) in rev.iter_mut().enumerate() {
            let mut x = ((i & 0xAAAA) >> 1) | ((i & 0x5555) << 1);
            x = ((x & 0xCCCC) >> 2) | ((x & 0x3333) << 2);
            x = ((x & 0xF0F0) >> 4) | ((x & 0x0F0F) << 4);
            *slot = ((((x & 0xFF00) >> 8) | ((x & 0x00FF) << 8)) >> 1) as u16;
        }
        let mut flt = [0u8; 288];
        for (i, slot) in flt.iter_mut().enumerate() {
            *slot = match i {
                0..144 => 8,
                144..256 => 9,
                256..280 => 7,
                _ => 8,
            };
        }
        let fdt = [5u8; 32];
        let flm = h_map(&flt, 9, &rev);
        let fdm = h_map(&fdt, 5, &rev);
        Tables {
            revfl,
            revfd,
            rev,
            flt,
            fdt,
            flm,
            fdm,
        }
    })
}

/// fflate's output: a zero-filled buffer of a fixed size it ORs bits into.
struct Out {
    bytes: Vec<u8>,
}
impl Out {
    fn or(&mut self, index: usize, value: u32) {
        if let Some(byte) = self.bytes.get_mut(index) {
            *byte |= value as u8;
        }
    }
    fn set(&mut self, index: usize, value: u32) {
        if let Some(byte) = self.bytes.get_mut(index) {
            *byte = value as u8;
        }
    }
    fn get(&self, index: usize) -> u32 {
        self.bytes.get(index).copied().map_or(0, u32::from)
    }
    /// `wbits`: at most 16 bits once shifted.
    fn wbits(&mut self, p: usize, v: u32) {
        let v = v << (p & 7);
        let o = p / 8;
        self.or(o, v);
        self.or(o + 1, v >> 8);
    }
    /// `wbits16`: at most 24 bits once shifted.
    fn wbits16(&mut self, p: usize, v: u32) {
        let v = v << (p & 7);
        let o = p / 8;
        self.or(o, v);
        self.or(o + 1, v >> 8);
        self.or(o + 2, v >> 16);
    }
}

fn shft(p: usize) -> usize {
    p.div_ceil(8)
}

/// `hTree(d, mb)`: code lengths for frequencies `d`, at most `mb` bits.
fn h_tree(d: &[u16], mb: u32) -> Result<(Vec<u8>, u32)> {
    #[derive(Clone, Copy)]
    struct Node {
        s: i32,
        f: u32,
        l: usize,
        r: usize,
    }
    const LEAF: usize = usize::MAX;
    let mut nodes: Vec<Node> = Vec::new();
    let mut t: Vec<usize> = Vec::new();
    for (i, &f) in d.iter().enumerate() {
        if f != 0 {
            t.push(nodes.len());
            nodes.push(Node {
                s: i as i32,
                f: u32::from(f),
                l: LEAF,
                r: LEAF,
            });
        }
    }
    let s = t.len();
    let mut t2 = t.clone();
    if s == 0 {
        return Ok((Vec::new(), 0));
    }
    if s == 1 {
        let symbol = nodes[t[0]].s as usize;
        let mut v = vec![0u8; symbol + 1];
        v[symbol] = 1;
        return Ok((v, 1));
    }
    // V8's sort is stable, as Rust's is.
    t.sort_by(|&a, &b| nodes[a].f.cmp(&nodes[b].f));
    let sentinel = nodes.len();
    nodes.push(Node {
        s: -1,
        f: 25001,
        l: LEAF,
        r: LEAF,
    });
    t.push(sentinel);
    let freq = |nodes: &[Node], t: &[usize], i: usize| -> Result<u32> {
        t.get(i).map(|&n| nodes[n].f).ok_or(Error::InvalidEntry)
    };
    let (mut i0, mut i1, mut i2) = (0usize, 1usize, 2usize);
    let (l, r) = (t[0], t[1]);
    let merged = nodes.len();
    nodes.push(Node {
        s: -1,
        f: nodes[l].f + nodes[r].f,
        l,
        r,
    });
    t[0] = merged;
    while i1 != s - 1 {
        let pick = if freq(&nodes, &t, i0)? < freq(&nodes, &t, i2)? {
            i0 += 1;
            i0 - 1
        } else {
            i2 += 1;
            i2 - 1
        };
        let l = *t.get(pick).ok_or(Error::InvalidEntry)?;
        let pick = if i0 != i1 && freq(&nodes, &t, i0)? < freq(&nodes, &t, i2)? {
            i0 += 1;
            i0 - 1
        } else {
            i2 += 1;
            i2 - 1
        };
        let r = *t.get(pick).ok_or(Error::InvalidEntry)?;
        let merged = nodes.len();
        nodes.push(Node {
            s: -1,
            f: nodes[l].f + nodes[r].f,
            l,
            r,
        });
        t[i1] = merged;
        i1 += 1;
    }
    let max_symbol = t2.iter().map(|&n| nodes[n].s).max().unwrap_or(0) as usize;
    let mut tr = vec![0u16; max_symbol + 1];
    // `ln`: depth of every leaf, the deepest returned.
    let mut mbt = 0u32;
    let mut stack = vec![(t[i1 - 1], 0u32)];
    while let Some((n, depth)) = stack.pop() {
        let node = nodes[n];
        if node.s == -1 {
            if node.l == LEAF || node.r == LEAF {
                return Err(Error::InvalidEntry);
            }
            stack.push((node.r, depth + 1));
            stack.push((node.l, depth + 1));
        } else {
            tr[node.s as usize] = depth as u16;
            mbt = mbt.max(depth);
        }
    }
    if mbt > mb {
        let mut i = 0usize;
        let mut dt: i64 = 0;
        let lft = mbt - mb;
        let cst: i64 = 1 << lft;
        t2.sort_by(|&a, &b| {
            let (a, b) = (nodes[a], nodes[b]);
            tr[b.s as usize].cmp(&tr[a.s as usize]).then(a.f.cmp(&b.f))
        });
        while i < s {
            let symbol = nodes[t2[i]].s as usize;
            if u32::from(tr[symbol]) > mb {
                dt += cst - (1i64 << (mbt - u32::from(tr[symbol])));
                tr[symbol] = mb as u16;
            } else {
                break;
            }
            i += 1;
        }
        dt >>= lft;
        while dt > 0 {
            let symbol = nodes[*t2.get(i).ok_or(Error::InvalidEntry)?].s as usize;
            if u32::from(tr[symbol]) < mb {
                dt -= 1i64 << (mb - u32::from(tr[symbol]) - 1);
                tr[symbol] += 1;
            } else {
                i += 1;
            }
        }
        let mut i = i as i64;
        while i >= 0 && dt != 0 {
            let symbol = nodes[*t2.get(i as usize).ok_or(Error::InvalidEntry)?].s as usize;
            if u32::from(tr[symbol]) == mb {
                tr[symbol] -= 1;
                dt += 1;
            }
            i -= 1;
        }
        mbt = mb;
    }
    Ok((tr.iter().map(|&v| v as u8).collect(), mbt))
}

/// `lc(c)`: run-length coded code lengths and how many lengths they cover.
fn lc(c: &[u8]) -> (Vec<u16>, usize) {
    let mut s = c.len();
    while s > 0 {
        s -= 1;
        if c[s] != 0 {
            break;
        }
    }
    s += 1;
    let at = |i: usize| c.get(i).copied().unwrap_or(0);
    let mut cl = Vec::with_capacity(s);
    let mut cln = at(0);
    let mut cls: u32 = 1;
    for i in 1..=s {
        if at(i) == cln && i != s {
            cls += 1;
        } else {
            if cln == 0 && cls > 2 {
                while cls > 138 {
                    cl.push(32754);
                    cls -= 138;
                }
                if cls > 2 {
                    cl.push(if cls > 10 {
                        (((cls - 11) << 5) | 28690) as u16
                    } else {
                        (((cls - 3) << 5) | 12305) as u16
                    });
                    cls = 0;
                }
            } else if cls > 3 {
                cl.push(u16::from(cln));
                cls -= 1;
                while cls > 6 {
                    cl.push(8304);
                    cls -= 6;
                }
                if cls > 2 {
                    cl.push((((cls - 3) << 5) | 8208) as u16);
                    cls = 0;
                }
            }
            while cls > 0 {
                cl.push(u16::from(cln));
                cls -= 1;
            }
            cls = 1;
            cln = at(i);
        }
    }
    (cl, s)
}

/// `clen(cf, cl)`: bits to code `cf` with lengths `cl`.
fn clen(cf: &[u16], cl: &[u8]) -> u64 {
    cl.iter()
        .enumerate()
        .map(|(i, &l)| u64::from(cf.get(i).copied().unwrap_or(0)) * u64::from(l))
        .sum()
}

/// `wfblk`: a stored block of `dat` at bit `pos`; the new bit position.
fn wfblk(out: &mut Out, pos: usize, dat: &[u8]) -> usize {
    let s = dat.len() as u32;
    let o = shft(pos + 2);
    out.set(o, s & 255);
    out.set(o + 1, s >> 8);
    out.set(o + 2, out.get(o) ^ 255);
    out.set(o + 3, out.get(o + 1) ^ 255);
    for (i, &byte) in dat.iter().enumerate() {
        out.set(o + i + 4, u32::from(byte));
    }
    (o + 4 + dat.len()) * 8
}

/// `wblk`: one block (stored, fixed or dynamic, whichever is shortest).
#[allow(clippy::too_many_arguments)]
fn wblk(
    dat: &[u8],
    out: &mut Out,
    last: bool,
    syms: &[u32],
    lf: &mut [u16; 288],
    df: &[u16; 32],
    eb: u64,
    bs: usize,
    bl: usize,
    mut p: usize,
) -> Result<usize> {
    let tables = tables();
    out.wbits(p, u32::from(last));
    p += 1;
    lf[256] += 1;
    let (dlt, mlb) = h_tree(lf, 15)?;
    let (ddt, mdb) = h_tree(df, 15)?;
    let (lclt, nlc) = lc(&dlt);
    let (lcdt, ndc) = lc(&ddt);
    let mut lcfreq = [0u16; 19];
    for &v in lclt.iter().chain(lcdt.iter()) {
        lcfreq[usize::from(v & 31)] += 1;
    }
    let (lct, mlcb) = h_tree(&lcfreq, 7)?;
    let lct_at = |i: usize| lct.get(i).copied().unwrap_or(0);
    let mut nlcc = 19usize;
    while nlcc > 4 && lct_at(CLIM[nlcc - 1]) == 0 {
        nlcc -= 1;
    }
    let flen = ((bl as u64) + 5) << 3;
    let ftlen = clen(lf, &tables.flt) + clen(df, &tables.fdt) + eb;
    let dtlen = clen(lf, &dlt)
        + clen(df, &ddt)
        + eb
        + 14
        + 3 * nlcc as u64
        + clen(&lcfreq, &lct)
        + 2 * u64::from(lcfreq[16])
        + 3 * u64::from(lcfreq[17])
        + 7 * u64::from(lcfreq[18]);
    if flen <= ftlen && flen <= dtlen {
        return Ok(wfblk(out, p, &dat[bs..bs + bl]));
    }
    out.wbits(p, 1 + u32::from(dtlen < ftlen));
    p += 2;
    let (lm, ll, dm, dl): (Vec<u16>, Vec<u8>, Vec<u16>, Vec<u8>);
    if dtlen < ftlen {
        lm = h_map(&dlt, mlb as usize, &tables.rev);
        ll = dlt;
        dm = h_map(&ddt, mdb as usize, &tables.rev);
        dl = ddt;
        let llm = h_map(&lct, mlcb as usize, &tables.rev);
        out.wbits(p, (nlc - 257) as u32);
        out.wbits(p + 5, (ndc - 1) as u32);
        out.wbits(p + 10, (nlcc - 4) as u32);
        p += 14;
        for (i, &code) in CLIM.iter().enumerate().take(nlcc) {
            out.wbits(p + 3 * i, u32::from(lct_at(code)));
        }
        p += 3 * nlcc;
        for clct in [&lclt, &lcdt] {
            for &entry in clct {
                let len = usize::from(entry & 31);
                out.wbits(p, u32::from(llm.get(len).copied().unwrap_or(0)));
                p += usize::from(lct_at(len));
                if len > 15 {
                    out.wbits(p, u32::from((entry >> 5) & 127));
                    p += usize::from(entry >> 12);
                }
            }
        }
    } else {
        lm = tables.flm.clone();
        ll = tables.flt.to_vec();
        dm = tables.fdm.clone();
        dl = tables.fdt.to_vec();
    }
    let code = |table: &[u16], i: usize| u32::from(table.get(i).copied().unwrap_or(0));
    let bits = |table: &[u8], i: usize| usize::from(table.get(i).copied().unwrap_or(0));
    for &sym in syms {
        if sym > 255 {
            let len = ((sym >> 18) & 31) as usize;
            out.wbits16(p, code(&lm, len + 257));
            p += bits(&ll, len + 257);
            if len > 7 {
                out.wbits(p, (sym >> 23) & 31);
                p += usize::from(FLEB[len]);
            }
            let dst = (sym & 31) as usize;
            out.wbits16(p, code(&dm, dst));
            p += bits(&dl, dst);
            if dst > 3 {
                out.wbits16(p, (sym >> 5) & 8191);
                p += usize::from(FDEB[dst]);
            }
        } else {
            out.wbits16(p, code(&lm, sym as usize));
            p += bits(&ll, sym as usize);
        }
    }
    out.wbits16(p, code(&lm, 256));
    Ok(p + bits(&ll, 256))
}

/// `deflateSync(dat, { level })`: a raw DEFLATE stream, byte for byte the
/// browser's. Level 0 writes stored blocks of 65,535 bytes.
pub fn deflate(dat: &[u8], level: u8) -> Result<Vec<u8>> {
    if level > 9 {
        return Err(Error::InvalidLimits);
    }
    let s = dat.len();
    let size = s + 5 * (1 + s.div_ceil(7000));
    let mut out = Out {
        bytes: vec![0; size],
    };
    let mut pos = 0usize;
    if level == 0 {
        let mut i = 0usize;
        // `i < s + lst` with `lst` 1: an empty input still gets its final block.
        while i < s + 1 {
            let mut e = i + 65535;
            if e >= s {
                out.set(pos / 8, 1);
                e = s;
            }
            pos = wfblk(&mut out, pos + 1, &dat[i..e]);
            i += 65535;
        }
    } else {
        // `Math.ceil(Math.max(8, Math.min(13, Math.log(n))) * 1.5)`: 12 to 20 bits.
        let plvl = ((s as f64).ln().clamp(8.0, 13.0) * 1.5).ceil() as u32;
        let msk = (1usize << plvl) - 1;
        let bs1 = plvl.div_ceil(3);
        let bs2 = 2 * bs1;
        let tables = tables();
        let opt = DEO[usize::from(level) - 1];
        let n = (opt >> 13) as usize;
        let c = opt & 8191;
        let mut prev = vec![0u16; 32768];
        let mut head = vec![0u16; msk + 1];
        let hsh = |i: usize| -> usize {
            ((u32::from(dat[i]) ^ (u32::from(dat[i + 1]) << bs1) ^ (u32::from(dat[i + 2]) << bs2))
                as usize)
                & msk
        };
        let at = |i: usize| dat.get(i).copied();
        let mut syms: Vec<u32> = Vec::with_capacity(25000);
        let mut lf = [0u16; 288];
        let mut df = [0u16; 32];
        let (mut lc_count, mut eb, mut i, mut wi, mut bs) = (0u32, 0u64, 0usize, 0usize, 0usize);
        while i + 2 < s {
            let hv = hsh(i);
            let mut imod = i & 32767;
            let mut pimod = usize::from(head[hv]);
            prev[imod] = pimod as u16;
            head[hv] = imod as u16;
            if wi <= i {
                let rem = s - i;
                if (lc_count > 7000 || syms.len() > 24576) && rem > 423 {
                    pos = wblk(
                        dat,
                        &mut out,
                        false,
                        &syms,
                        &mut lf,
                        &df,
                        eb,
                        bs,
                        i - bs,
                        pos,
                    )?;
                    syms.clear();
                    lc_count = 0;
                    eb = 0;
                    bs = i;
                    lf[..286].fill(0);
                    df[..30].fill(0);
                }
                let mut l = 2usize;
                let mut d = 0usize;
                let mut ch = c;
                let mut dif = imod.wrapping_sub(pimod) & 32767;
                if rem > 2 && hv == hsh(i - dif) {
                    let maxn = n.min(rem) - 1;
                    let maxd = i.min(32767);
                    let ml = rem.min(258);
                    loop {
                        if dif > maxd {
                            break;
                        }
                        ch -= 1;
                        if ch == 0 || imod == pimod {
                            break;
                        }
                        if at(i + l) == at(i + l - dif) {
                            let mut nl = 0usize;
                            while nl < ml && at(i + nl) == at(i + nl - dif) {
                                nl += 1;
                            }
                            if nl > l {
                                l = nl;
                                d = dif;
                                if nl > maxn {
                                    break;
                                }
                                let mmd = dif.min(nl - 2);
                                let mut md = 0usize;
                                for j in 0..mmd {
                                    let ti = (i - dif + j) & 32767;
                                    let pti = usize::from(prev[ti]);
                                    let cd = ti.wrapping_sub(pti) & 32767;
                                    if cd > md {
                                        md = cd;
                                        pimod = ti;
                                    }
                                }
                            }
                        }
                        imod = pimod;
                        pimod = usize::from(prev[imod]);
                        dif += imod.wrapping_sub(pimod) & 32767;
                    }
                }
                if d != 0 {
                    let rl = tables.revfl[l];
                    let rd = tables.revfd[d];
                    syms.push(268435456 | (rl << 18) | rd);
                    let lin = (rl & 31) as usize;
                    let din = (rd & 31) as usize;
                    eb += u64::from(FLEB[lin]) + u64::from(FDEB[din]);
                    lf[257 + lin] += 1;
                    df[din] += 1;
                    wi = i + l;
                    lc_count += 1;
                } else {
                    syms.push(u32::from(dat[i]));
                    lf[usize::from(dat[i])] += 1;
                }
            }
            i += 1;
        }
        i = i.max(wi);
        while i < s {
            syms.push(u32::from(dat[i]));
            lf[usize::from(dat[i])] += 1;
            i += 1;
        }
        pos = wblk(
            dat,
            &mut out,
            true,
            &syms,
            &mut lf,
            &df,
            eb,
            bs,
            i - bs,
            pos,
        )?;
    }
    let end = shft(pos).min(out.bytes.len());
    out.bytes.truncate(end);
    Ok(out.bytes)
}

/// The order `writeDeterministicZip`'s members reach the archive: sorted by
/// UTF-16 code units, then enumerated as a JavaScript object enumerates its
/// keys — array-index names (canonical decimal integers below 2^32 − 1) first,
/// ascending.
fn array_index(name: &str) -> Option<u32> {
    let value: u32 = name.parse().ok()?;
    (value != u32::MAX && value.to_string() == name).then_some(value)
}

/// A member queued for [`Zip`]: its compressed bytes and what its headers say.
struct Entry {
    path: String,
    crc: u32,
    size: u64,
    compressed: Vec<u8>,
    method: u16,
}

/// `writeDeterministicZip(files)`: members added in any order, compressed as
/// they arrive (level 6, or stored for already-compressed suffixes), written
/// in the browser's order with fflate's headers (UTF-8 flag only for a
/// non-ASCII name, Unix 0644, 1980-01-01 local time, no extra fields) under
/// the browser's default ZIP limits. Holds each member's compressed bytes
/// until [`Zip::finish`]; never an uncompressed member beyond the call adding it.
pub struct Zip {
    limits: ZipLimits,
    entries: Vec<Entry>,
    total: u64,
}

impl Default for Zip {
    fn default() -> Self {
        Self::new(ZipLimits::default())
    }
}

impl Zip {
    pub fn new(limits: ZipLimits) -> Self {
        Self {
            limits,
            entries: Vec::new(),
            total: 0,
        }
    }

    /// Adds member `path` holding `bytes`.
    pub fn add(&mut self, path: &str, bytes: &[u8]) -> Result<()> {
        let limits = self.limits.validate()?;
        validate_package_path(path, limits.path_bytes)?;
        if self.entries.iter().any(|entry| entry.path == path) {
            return Err(Error::DuplicatePath);
        }
        if self.entries.len() as u64 >= limits.entries || bytes.len() as u64 > limits.entry_bytes {
            return Err(Error::ResourceLimit);
        }
        self.total += bytes.len() as u64;
        if self.total > limits.total_uncompressed_bytes {
            return Err(Error::ResourceLimit);
        }
        let extension = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
        let stored = path.contains('.')
            && ["3mf", "jpg", "jpeg", "mp4", "png", "webp", "zip"]
                .iter()
                .any(|e| extension.eq_ignore_ascii_case(e));
        let mut crc = crc32fast::Hasher::new();
        crc.update(bytes);
        self.entries.push(Entry {
            path: path.to_owned(),
            crc: crc.finalize(),
            size: bytes.len() as u64,
            compressed: if stored {
                bytes.to_vec()
            } else {
                deflate(bytes, 6)?
            },
            method: if stored { 0 } else { 8 },
        });
        Ok(())
    }

    /// The archive's length once written.
    pub fn len(&self) -> u64 {
        self.entries
            .iter()
            .map(|e| 76 + 2 * e.path.len() as u64 + e.compressed.len() as u64)
            .sum::<u64>()
            + 22
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Writes the archive to `output`; answers its length.
    pub fn finish(mut self, output: &mut (impl Write + ?Sized)) -> Result<u64> {
        let length = self.len();
        if length > self.limits.archive_bytes {
            return Err(Error::ResourceLimit);
        }
        self.entries
            .sort_by(|a, b| match (array_index(&a.path), array_index(&b.path)) {
                (Some(a), Some(b)) => a.cmp(&b),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => a.path.encode_utf16().cmp(b.path.encode_utf16()),
            });
        let mut offsets = Vec::with_capacity(self.entries.len());
        let mut offset = 0u64;
        for entry in &self.entries {
            offsets.push(offset);
            let header = header(entry, None);
            output.write_all(&header)?;
            output.write_all(&entry.compressed)?;
            offset += header.len() as u64 + entry.compressed.len() as u64;
        }
        let central = offset;
        for (entry, &local) in self.entries.iter().zip(&offsets) {
            let header = header(entry, Some(local));
            output.write_all(&header)?;
            offset += header.len() as u64;
        }
        let mut end = [0u8; 22];
        end[..4].copy_from_slice(&0x0605_4b50u32.to_le_bytes());
        let count = self.entries.len() as u16;
        end[8..10].copy_from_slice(&count.to_le_bytes());
        end[10..12].copy_from_slice(&count.to_le_bytes());
        end[12..16].copy_from_slice(&((offset - central) as u32).to_le_bytes());
        end[16..20].copy_from_slice(&(central as u32).to_le_bytes());
        output.write_all(&end)?;
        Ok(offset + 22)
    }
}

/// `wzh`: a local header, or with the member's offset its central record.
fn header(entry: &Entry, local: Option<u64>) -> Vec<u8> {
    let name = entry.path.as_bytes();
    let utf8 = name.len() != entry.path.encode_utf16().count();
    let mut d = Vec::with_capacity(46 + name.len());
    let signature: u32 = if local.is_some() {
        0x0201_4b50
    } else {
        0x0403_4b50
    };
    d.extend_from_slice(&signature.to_le_bytes());
    if local.is_some() {
        // Version made by: 2.0, Unix.
        d.extend_from_slice(&[20, 3]);
    }
    d.extend_from_slice(&[20, 0]);
    d.extend_from_slice(&[0, if utf8 { 8 } else { 0 }]);
    d.extend_from_slice(&entry.method.to_le_bytes());
    // 1980-01-01 00:00:00 local time.
    d.extend_from_slice(&0x0021_0000u32.to_le_bytes());
    d.extend_from_slice(&entry.crc.to_le_bytes());
    d.extend_from_slice(&(entry.compressed.len() as u32).to_le_bytes());
    d.extend_from_slice(&(entry.size as u32).to_le_bytes());
    d.extend_from_slice(&(name.len() as u16).to_le_bytes());
    d.extend_from_slice(&0u16.to_le_bytes());
    if let Some(offset) = local {
        // Comment length, disk, internal attributes, external (0644 << 16), offset.
        d.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        d.extend_from_slice(&(0o644u32 << 16).to_le_bytes());
        d.extend_from_slice(&(offset as u32).to_le_bytes());
    }
    d.extend_from_slice(name);
    d
}
