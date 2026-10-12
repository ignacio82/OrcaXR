//! Image files a thumbnail is written as: PNG (RGBA, deflated as zlib) and
//! baseline JPEG (YCbCr 4:4:4). Both are deterministic, so every host that
//! renders the same pixels writes the same bytes.
use flate2::{Compression, write::ZlibEncoder};
use std::io::Write;

/// An RGBA image, rows top to bottom, four bytes a pixel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// A PNG of `image`: 8-bit RGBA, no interlace, each row unfiltered.
pub fn png(image: &Rgba) -> Vec<u8> {
    let stride = image.width as usize * 4;
    let mut raw = Vec::with_capacity((stride + 1) * image.height as usize);
    for row in image.pixels.chunks_exact(stride) {
        raw.push(0);
        raw.extend_from_slice(row);
    }
    let mut zlib = ZlibEncoder::new(Vec::new(), Compression::new(9));
    zlib.write_all(&raw)
        .expect("an in-memory deflate cannot fail");
    let compressed = zlib.finish().expect("an in-memory deflate cannot fail");
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&image.width.to_be_bytes());
    header.extend_from_slice(&image.height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &compressed);
    chunk(&mut out, b"IEND", &[]);
    out
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut crc = crc32fast::Hasher::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc.finalize().to_be_bytes());
}

// --- Baseline JPEG ---------------------------------------------------------------------------

const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
const LUMA_QUANT: [u16; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
    92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_QUANT: [u16; 64] = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];
// The standard Huffman tables (ITU T.81, Annex K.3).
const DC_LUMA_BITS: [u8; 16] = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS: [u8; 16] = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALUES: [u8; 12] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS: [u8; 16] = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALUES: [u8; 162] = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];
const AC_CHROMA_BITS: [u8; 16] = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALUES: [u8; 162] = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
];

/// A Huffman table as (code, length) by symbol.
struct Huffman([(u16, u8); 256]);
impl Huffman {
    fn new(bits: &[u8; 16], values: &[u8]) -> Self {
        let mut table = [(0u16, 0u8); 256];
        let mut code = 0u16;
        let mut k = 0;
        for (length, &count) in bits.iter().enumerate() {
            for _ in 0..count {
                table[values[k] as usize] = (code, length as u8 + 1);
                code += 1;
                k += 1;
            }
            code <<= 1;
        }
        Self(table)
    }
}

struct Bits {
    out: Vec<u8>,
    buffer: u32,
    count: u32,
}
impl Bits {
    fn put(&mut self, code: u16, length: u8) {
        self.buffer = (self.buffer << length) | u32::from(code);
        self.count += u32::from(length);
        while self.count >= 8 {
            let byte = (self.buffer >> (self.count - 8)) as u8;
            self.out.push(byte);
            // Byte stuffing: a 0xFF in the entropy-coded data is followed by 0x00.
            if byte == 0xff {
                self.out.push(0);
            }
            self.count -= 8;
        }
        self.buffer &= (1 << self.count) - 1;
    }
    fn flush(&mut self) {
        if self.count > 0 {
            let pad = 8 - self.count as u8;
            self.put((1 << pad) - 1, pad);
        }
    }
}

/// The libjpeg quality scaling of a base table.
fn scaled(base: &[u16; 64], quality: u32) -> [u16; 64] {
    let scale = if quality < 50 {
        5000 / quality
    } else {
        200 - quality * 2
    };
    base.map(|q| ((u32::from(q) * scale + 50) / 100).clamp(1, 255) as u16)
}

/// Magnitude category and bits of a coefficient.
fn category(value: i32) -> (u8, u16) {
    let magnitude = value.unsigned_abs();
    let size = (32 - magnitude.leading_zeros()) as u8;
    let bits = if value < 0 {
        (value - 1) as u32 & ((1 << size) - 1)
    } else {
        value as u32
    };
    (size, bits as u16)
}

/// A baseline JPEG of `image` at `quality` (1–100), each transparent pixel
/// composited over black, as a canvas does before encoding one.
pub fn jpeg(image: &Rgba, quality: u32) -> Vec<u8> {
    let quality = quality.clamp(1, 100);
    let tables = [scaled(&LUMA_QUANT, quality), scaled(&CHROMA_QUANT, quality)];
    let dc = [
        Huffman::new(&DC_LUMA_BITS, &DC_VALUES),
        Huffman::new(&DC_CHROMA_BITS, &DC_VALUES),
    ];
    let ac = [
        Huffman::new(&AC_LUMA_BITS, &AC_LUMA_VALUES),
        Huffman::new(&AC_CHROMA_BITS, &AC_CHROMA_VALUES),
    ];
    let mut out = vec![0xff, 0xd8];
    // APP0 (JFIF 1.1, no density).
    out.extend_from_slice(&[
        0xff, 0xe0, 0, 16, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    ]);
    for (id, table) in tables.iter().enumerate() {
        out.extend_from_slice(&[0xff, 0xdb, 0, 67, id as u8]);
        out.extend(ZIGZAG.iter().map(|&i| table[i] as u8));
    }
    let (width, height) = (image.width as u16, image.height as u16);
    out.extend_from_slice(&[0xff, 0xc0, 0, 17, 8]);
    out.extend_from_slice(&height.to_be_bytes());
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&[3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]);
    for (class, id, bits, values) in [
        (0u8, 0u8, &DC_LUMA_BITS, &DC_VALUES[..]),
        (1, 0, &AC_LUMA_BITS, &AC_LUMA_VALUES[..]),
        (0, 1, &DC_CHROMA_BITS, &DC_VALUES[..]),
        (1, 1, &AC_CHROMA_BITS, &AC_CHROMA_VALUES[..]),
    ] {
        let length = (3 + 16 + values.len()) as u16;
        out.extend_from_slice(&[0xff, 0xc4]);
        out.extend_from_slice(&length.to_be_bytes());
        out.push(class << 4 | id);
        out.extend_from_slice(bits);
        out.extend_from_slice(values);
    }
    out.extend_from_slice(&[0xff, 0xda, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);

    let mut bits = Bits {
        out,
        buffer: 0,
        count: 0,
    };
    let mut previous = [0i32; 3];
    let w = image.width as usize;
    let h = image.height as usize;
    let sample = |x: usize, y: usize| {
        let at = (y.min(h - 1) * w + x.min(w - 1)) * 4;
        let alpha = f64::from(image.pixels[at + 3]) / 255.0;
        let [r, g, b] = [0, 1, 2].map(|c| f64::from(image.pixels[at + c]) * alpha);
        [
            0.299 * r + 0.587 * g + 0.114 * b - 128.0,
            -0.168_735_892 * r - 0.331_264_108 * g + 0.5 * b,
            0.5 * r - 0.418_687_589 * g - 0.081_312_411 * b,
        ]
    };
    for by in (0..h).step_by(8) {
        for bx in (0..w).step_by(8) {
            let mut blocks = [[0f64; 64]; 3];
            for y in 0..8 {
                for x in 0..8 {
                    let value = sample(bx + x, by + y);
                    for c in 0..3 {
                        blocks[c][y * 8 + x] = value[c];
                    }
                }
            }
            for c in 0..3 {
                let table = &tables[usize::from(c != 0)];
                let coefficients = dct(&blocks[c]);
                let mut quantized = [0i32; 64];
                for (k, &i) in ZIGZAG.iter().enumerate() {
                    quantized[k] = (coefficients[i] / f64::from(table[i])).round() as i32;
                }
                let class = usize::from(c != 0);
                let diff = quantized[0] - previous[c];
                previous[c] = quantized[0];
                let (size, value) = category(diff);
                let (code, length) = dc[class].0[size as usize];
                bits.put(code, length);
                if size > 0 {
                    bits.put(value, size);
                }
                let mut run = 0u8;
                for &coefficient in &quantized[1..] {
                    if coefficient == 0 {
                        run += 1;
                        continue;
                    }
                    while run >= 16 {
                        let (code, length) = ac[class].0[0xf0];
                        bits.put(code, length);
                        run -= 16;
                    }
                    let (size, value) = category(coefficient);
                    let (code, length) = ac[class].0[usize::from(run << 4 | size)];
                    bits.put(code, length);
                    bits.put(value, size);
                    run = 0;
                }
                if run > 0 {
                    let (code, length) = ac[class].0[0x00];
                    bits.put(code, length);
                }
            }
        }
    }
    bits.flush();
    let mut out = bits.out;
    out.extend_from_slice(&[0xff, 0xd9]);
    out
}

/// The 8 × 8 forward DCT-II, in its separable form. The cosines are the
/// shared core's own (V8's fdlibm), never the platform's, so every host
/// writes the same bytes.
fn dct(block: &[f64; 64]) -> [f64; 64] {
    let cosine = |x: usize, u: usize| {
        orcaxr_project::js_math::cos((2 * x + 1) as f64 * u as f64 * std::f64::consts::PI / 16.0)
    };
    let weight = |u: usize| {
        if u == 0 {
            std::f64::consts::FRAC_1_SQRT_2
        } else {
            1.0
        }
    };
    let mut rows = [0f64; 64];
    for y in 0..8 {
        for u in 0..8 {
            let mut sum = 0.0;
            for x in 0..8 {
                sum += block[y * 8 + x] * cosine(x, u);
            }
            rows[y * 8 + u] = sum * weight(u) / 2.0;
        }
    }
    let mut out = [0f64; 64];
    for u in 0..8 {
        for v in 0..8 {
            let mut sum = 0.0;
            for y in 0..8 {
                sum += rows[y * 8 + u] * cosine(y, v);
            }
            out[v * 8 + u] = sum * weight(v) / 2.0;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_png_has_its_header_and_chunks() {
        let image = Rgba {
            width: 2,
            height: 1,
            pixels: vec![255, 0, 0, 255, 0, 0, 0, 0],
        };
        let bytes = png(&image);
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&bytes[12..16], b"IHDR");
        assert_eq!(&bytes[16..24], &[0, 0, 0, 2, 0, 0, 0, 1]);
        assert_eq!(&bytes[bytes.len() - 8..bytes.len() - 4], b"IEND");
    }

    #[test]
    fn a_jpeg_is_framed_and_stuffed() {
        let image = Rgba {
            width: 9,
            height: 3,
            pixels: (0..9 * 3 * 4).map(|i| (i * 37 % 256) as u8).collect(),
        };
        let bytes = jpeg(&image, 92);
        assert_eq!(&bytes[..2], &[0xff, 0xd8]);
        assert_eq!(&bytes[bytes.len() - 2..], &[0xff, 0xd9]);
        // Between the scan header and the end, every 0xFF is stuffed.
        let scan = bytes.windows(2).position(|w| w == [0xff, 0xda]).unwrap() + 14;
        let data = &bytes[scan..bytes.len() - 2];
        for (i, &byte) in data.iter().enumerate() {
            if byte == 0xff {
                assert_eq!(data.get(i + 1), Some(&0));
            }
        }
    }
}
