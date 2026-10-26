/* Stand-in for libimobiledevice's common/endianness.h: only the big-endian 32-bit helpers ddbackup.c uses. */
#ifndef DDBACKUP_ENDIANNESS_H
#define DDBACKUP_ENDIANNESS_H
#if defined(__APPLE__)
#include <libkern/OSByteOrder.h>
#define htobe32(x) OSSwapHostToBigInt32(x)
#define be32toh(x) OSSwapBigToHostInt32(x)
#elif defined(_WIN32)
#include <stdlib.h>
#define htobe32(x) _byteswap_ulong(x)
#define be32toh(x) _byteswap_ulong(x)
#else
#include <endian.h>
#endif
#endif
