package dev.orcaxr.core;

/** Narrow binding to the shared Rust core. Calls run on an owned background task. */
public final class NativeCore {
    static { System.loadLibrary("orcaxr_android"); }
    private NativeCore() {}
    public static native String coreInfo();
    public static native String evaluate(String request);
}
