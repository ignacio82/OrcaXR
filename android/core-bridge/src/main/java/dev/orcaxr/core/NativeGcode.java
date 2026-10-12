package dev.orcaxr.core;

import java.nio.ByteBuffer;

final class NativeGcode {
    static { System.loadLibrary("orcaxr_android"); }
    private NativeGcode() {}
    static native long open(int version, int sourceUnits, String options);
    static native void append(long handle, int offset, char[] units);
    static native String seal(long handle);
    static native String page(long handle, int start, int count);
    static native String textWindow(long handle, double from, double count);
    static native String textSearch(long handle, char[] query, int limit);
    static native String summary(long handle);
    static native int prepare(long handle, int first, int last);
    static native int prepareView(long handle, String request);
    static native void copy(long handle, ByteBuffer target);
    static native void close(long handle);
    static native char[] decodeUtf8(byte[] bytes);
    // What the status line says of a finished slice, streamed through (SliceStatusTally).
    static native long tallyOpen();
    static native void tallyPush(long handle, byte[] bytes, int length);
    static native String tallyFigures(long handle);
    static native void tallyClose(long handle);
    // Where a G-code's thumbnail blocks go, found as it streams through (GcodeThumbnails).
    static native long anchorOpen();
    static native void anchorPush(long handle, byte[] bytes, int length);
    static native long anchorFinish(long handle, int blocks);
    static native void anchorClose(long handle);
}
