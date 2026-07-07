/* OrcaXR WASM shim: OpenSSL-compatible MD5 API backed by a public-domain
 * implementation (derived from Alexander Peslyak's md5.c, released to the
 * public domain). libslic3r only uses MD5 for content hashing (3MF part
 * checksums, cache keys) — no security property is relied on — so shipping
 * this instead of cross-building all of OpenSSL keeps the WASM link small.
 *
 * Injected via -isystem <repo>/wasm/shim-include ahead of the sysroot, so
 * `#include <openssl/md5.h>` in Utils.hpp / bbs_3mf.cpp resolves here.
 */
#ifndef ORCAXR_WASM_OPENSSL_MD5_SHIM_H
#define ORCAXR_WASM_OPENSSL_MD5_SHIM_H

#include <stddef.h>
#include <string.h>

#define MD5_DIGEST_LENGTH 16

typedef struct {
    unsigned int lo, hi;
    unsigned int a, b, c, d;
    unsigned char buffer[64];
} MD5_CTX;

#define ORCAXR_MD5_F(x, y, z) ((z) ^ ((x) & ((y) ^ (z))))
#define ORCAXR_MD5_G(x, y, z) ((y) ^ ((z) & ((x) ^ (y))))
#define ORCAXR_MD5_H(x, y, z) (((x) ^ (y)) ^ (z))
#define ORCAXR_MD5_H2(x, y, z) ((x) ^ ((y) ^ (z)))
#define ORCAXR_MD5_I(x, y, z) ((y) ^ ((x) | ~(z)))

#define ORCAXR_MD5_STEP(f, a, b, c, d, x, t, s)                              \
    (a) += f((b), (c), (d)) + (x) + (t);                                     \
    (a) = (((a) << (s)) | (((a) & 0xffffffffu) >> (32 - (s))));              \
    (a) += (b);

#define ORCAXR_MD5_SET(n)                                                    \
    (ctx->buffer[(n) * 4] | ((unsigned int)ctx->buffer[(n) * 4 + 1] << 8) |  \
     ((unsigned int)ctx->buffer[(n) * 4 + 2] << 16) |                        \
     ((unsigned int)ctx->buffer[(n) * 4 + 3] << 24))
#define ORCAXR_MD5_GET(n) ORCAXR_MD5_SET(n)

static const void *orcaxr_md5_body(MD5_CTX *ctx, const void *data, size_t size) {
    const unsigned char *ptr = (const unsigned char *)data;
    unsigned int a = ctx->a, b = ctx->b, c = ctx->c, d = ctx->d;
    unsigned int saved_a, saved_b, saved_c, saved_d;

    do {
        saved_a = a; saved_b = b; saved_c = c; saved_d = d;
        memcpy(ctx->buffer, ptr, 64);

        ORCAXR_MD5_STEP(ORCAXR_MD5_F, a, b, c, d, ORCAXR_MD5_SET(0), 0xd76aa478, 7)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, d, a, b, c, ORCAXR_MD5_SET(1), 0xe8c7b756, 12)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, c, d, a, b, ORCAXR_MD5_SET(2), 0x242070db, 17)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, b, c, d, a, ORCAXR_MD5_SET(3), 0xc1bdceee, 22)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, a, b, c, d, ORCAXR_MD5_SET(4), 0xf57c0faf, 7)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, d, a, b, c, ORCAXR_MD5_SET(5), 0x4787c62a, 12)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, c, d, a, b, ORCAXR_MD5_SET(6), 0xa8304613, 17)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, b, c, d, a, ORCAXR_MD5_SET(7), 0xfd469501, 22)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, a, b, c, d, ORCAXR_MD5_SET(8), 0x698098d8, 7)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, d, a, b, c, ORCAXR_MD5_SET(9), 0x8b44f7af, 12)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, c, d, a, b, ORCAXR_MD5_SET(10), 0xffff5bb1, 17)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, b, c, d, a, ORCAXR_MD5_SET(11), 0x895cd7be, 22)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, a, b, c, d, ORCAXR_MD5_SET(12), 0x6b901122, 7)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, d, a, b, c, ORCAXR_MD5_SET(13), 0xfd987193, 12)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, c, d, a, b, ORCAXR_MD5_SET(14), 0xa679438e, 17)
        ORCAXR_MD5_STEP(ORCAXR_MD5_F, b, c, d, a, ORCAXR_MD5_SET(15), 0x49b40821, 22)

        ORCAXR_MD5_STEP(ORCAXR_MD5_G, a, b, c, d, ORCAXR_MD5_GET(1), 0xf61e2562, 5)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, d, a, b, c, ORCAXR_MD5_GET(6), 0xc040b340, 9)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, c, d, a, b, ORCAXR_MD5_GET(11), 0x265e5a51, 14)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, b, c, d, a, ORCAXR_MD5_GET(0), 0xe9b6c7aa, 20)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, a, b, c, d, ORCAXR_MD5_GET(5), 0xd62f105d, 5)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, d, a, b, c, ORCAXR_MD5_GET(10), 0x02441453, 9)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, c, d, a, b, ORCAXR_MD5_GET(15), 0xd8a1e681, 14)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, b, c, d, a, ORCAXR_MD5_GET(4), 0xe7d3fbc8, 20)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, a, b, c, d, ORCAXR_MD5_GET(9), 0x21e1cde6, 5)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, d, a, b, c, ORCAXR_MD5_GET(14), 0xc33707d6, 9)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, c, d, a, b, ORCAXR_MD5_GET(3), 0xf4d50d87, 14)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, b, c, d, a, ORCAXR_MD5_GET(8), 0x455a14ed, 20)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, a, b, c, d, ORCAXR_MD5_GET(13), 0xa9e3e905, 5)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, d, a, b, c, ORCAXR_MD5_GET(2), 0xfcefa3f8, 9)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, c, d, a, b, ORCAXR_MD5_GET(7), 0x676f02d9, 14)
        ORCAXR_MD5_STEP(ORCAXR_MD5_G, b, c, d, a, ORCAXR_MD5_GET(12), 0x8d2a4c8a, 20)

        ORCAXR_MD5_STEP(ORCAXR_MD5_H, a, b, c, d, ORCAXR_MD5_GET(5), 0xfffa3942, 4)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H2, d, a, b, c, ORCAXR_MD5_GET(8), 0x8771f681, 11)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H, c, d, a, b, ORCAXR_MD5_GET(11), 0x6d9d6122, 16)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H2, b, c, d, a, ORCAXR_MD5_GET(14), 0xfde5380c, 23)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H, a, b, c, d, ORCAXR_MD5_GET(1), 0xa4beea44, 4)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H2, d, a, b, c, ORCAXR_MD5_GET(4), 0x4bdecfa9, 11)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H, c, d, a, b, ORCAXR_MD5_GET(7), 0xf6bb4b60, 16)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H2, b, c, d, a, ORCAXR_MD5_GET(10), 0xbebfbc70, 23)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H, a, b, c, d, ORCAXR_MD5_GET(13), 0x289b7ec6, 4)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H2, d, a, b, c, ORCAXR_MD5_GET(0), 0xeaa127fa, 11)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H, c, d, a, b, ORCAXR_MD5_GET(3), 0xd4ef3085, 16)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H2, b, c, d, a, ORCAXR_MD5_GET(6), 0x04881d05, 23)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H, a, b, c, d, ORCAXR_MD5_GET(9), 0xd9d4d039, 4)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H2, d, a, b, c, ORCAXR_MD5_GET(12), 0xe6db99e5, 11)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H, c, d, a, b, ORCAXR_MD5_GET(15), 0x1fa27cf8, 16)
        ORCAXR_MD5_STEP(ORCAXR_MD5_H2, b, c, d, a, ORCAXR_MD5_GET(2), 0xc4ac5665, 23)

        ORCAXR_MD5_STEP(ORCAXR_MD5_I, a, b, c, d, ORCAXR_MD5_GET(0), 0xf4292244, 6)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, d, a, b, c, ORCAXR_MD5_GET(7), 0x432aff97, 10)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, c, d, a, b, ORCAXR_MD5_GET(14), 0xab9423a7, 15)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, b, c, d, a, ORCAXR_MD5_GET(5), 0xfc93a039, 21)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, a, b, c, d, ORCAXR_MD5_GET(12), 0x655b59c3, 6)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, d, a, b, c, ORCAXR_MD5_GET(3), 0x8f0ccc92, 10)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, c, d, a, b, ORCAXR_MD5_GET(10), 0xffeff47d, 15)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, b, c, d, a, ORCAXR_MD5_GET(1), 0x85845dd1, 21)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, a, b, c, d, ORCAXR_MD5_GET(8), 0x6fa87e4f, 6)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, d, a, b, c, ORCAXR_MD5_GET(15), 0xfe2ce6e0, 10)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, c, d, a, b, ORCAXR_MD5_GET(6), 0xa3014314, 15)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, b, c, d, a, ORCAXR_MD5_GET(13), 0x4e0811a1, 21)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, a, b, c, d, ORCAXR_MD5_GET(4), 0xf7537e82, 6)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, d, a, b, c, ORCAXR_MD5_GET(11), 0xbd3af235, 10)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, c, d, a, b, ORCAXR_MD5_GET(2), 0x2ad7d2bb, 15)
        ORCAXR_MD5_STEP(ORCAXR_MD5_I, b, c, d, a, ORCAXR_MD5_GET(9), 0xeb86d391, 21)

        a += saved_a; b += saved_b; c += saved_c; d += saved_d;
        ptr += 64;
    } while (size -= 64);

    ctx->a = a; ctx->b = b; ctx->c = c; ctx->d = d;
    return ptr;
}

static inline int MD5_Init(MD5_CTX *ctx) {
    ctx->a = 0x67452301u;
    ctx->b = 0xefcdab89u;
    ctx->c = 0x98badcfeu;
    ctx->d = 0x10325476u;
    ctx->lo = 0;
    ctx->hi = 0;
    return 1;
}

static inline int MD5_Update(MD5_CTX *ctx, const void *data, size_t size) {
    unsigned int saved_lo = ctx->lo;
    unsigned long used, available;

    if ((ctx->lo = (saved_lo + size) & 0x1fffffffu) < saved_lo) ctx->hi++;
    ctx->hi += (unsigned int)(size >> 29);
    used = saved_lo & 0x3f;

    if (used) {
        available = 64 - used;
        if (size < available) {
            memcpy(&ctx->buffer[used], data, size);
            return 1;
        }
        memcpy(&ctx->buffer[used], data, available);
        data = (const unsigned char *)data + available;
        size -= available;
        {
            unsigned char tmp[64];
            memcpy(tmp, ctx->buffer, 64);
            orcaxr_md5_body(ctx, tmp, 64);
        }
    }
    if (size >= 64) {
        data = orcaxr_md5_body(ctx, data, size & ~(size_t)0x3f);
        size &= 0x3f;
    }
    memcpy(ctx->buffer, data, size);
    return 1;
}

static inline int MD5_Final(unsigned char *result, MD5_CTX *ctx) {
    unsigned long used, available;

    used = ctx->lo & 0x3f;
    ctx->buffer[used++] = 0x80;
    available = 64 - used;

    if (available < 8) {
        memset(&ctx->buffer[used], 0, available);
        orcaxr_md5_body(ctx, ctx->buffer, 64);
        used = 0;
        available = 64;
    }
    memset(&ctx->buffer[used], 0, available - 8);

    ctx->lo <<= 3;
    ctx->buffer[56] = (unsigned char)(ctx->lo);
    ctx->buffer[57] = (unsigned char)(ctx->lo >> 8);
    ctx->buffer[58] = (unsigned char)(ctx->lo >> 16);
    ctx->buffer[59] = (unsigned char)(ctx->lo >> 24);
    ctx->buffer[60] = (unsigned char)(ctx->hi);
    ctx->buffer[61] = (unsigned char)(ctx->hi >> 8);
    ctx->buffer[62] = (unsigned char)(ctx->hi >> 16);
    ctx->buffer[63] = (unsigned char)(ctx->hi >> 24);

    orcaxr_md5_body(ctx, ctx->buffer, 64);

    result[0] = (unsigned char)(ctx->a);
    result[1] = (unsigned char)(ctx->a >> 8);
    result[2] = (unsigned char)(ctx->a >> 16);
    result[3] = (unsigned char)(ctx->a >> 24);
    result[4] = (unsigned char)(ctx->b);
    result[5] = (unsigned char)(ctx->b >> 8);
    result[6] = (unsigned char)(ctx->b >> 16);
    result[7] = (unsigned char)(ctx->b >> 24);
    result[8] = (unsigned char)(ctx->c);
    result[9] = (unsigned char)(ctx->c >> 8);
    result[10] = (unsigned char)(ctx->c >> 16);
    result[11] = (unsigned char)(ctx->c >> 24);
    result[12] = (unsigned char)(ctx->d);
    result[13] = (unsigned char)(ctx->d >> 8);
    result[14] = (unsigned char)(ctx->d >> 16);
    result[15] = (unsigned char)(ctx->d >> 24);

    memset(ctx, 0, sizeof(*ctx));
    return 1;
}

#endif /* ORCAXR_WASM_OPENSSL_MD5_SHIM_H */
