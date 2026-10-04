package dev.orcaxr.core;

import java.nio.ByteBuffer;

final class NativeGcode {
    static { System.loadLibrary("orcaxr_android"); }
    private NativeGcode() {}
    static native long open(int version, int sourceUnits, String options);
    static native void append(long handle, int offset, char[] units);
    static native String seal(long handle);
    static native String page(long handle, int start, int count);
    static native int prepare(long handle, int first, int last);
    static native int prepareView(long handle, String request);
    static native void copy(long handle, ByteBuffer target);
    static native void close(long handle);
}
