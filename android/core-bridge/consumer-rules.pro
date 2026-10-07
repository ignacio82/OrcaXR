# JNI exports bind this exact class and its native method names.
-keep class dev.orcaxr.core.NativeCore { native <methods>; }
-keep class dev.orcaxr.core.NativeGcode { native <methods>; }
-keep class dev.orcaxr.core.NativeProject { native <methods>; }
-keep interface dev.orcaxr.core.LocalTimestampResolver { long resolve(long); }
-keep interface dev.orcaxr.core.ProjectJsonSink { void write(byte[]); }
-keepclassmembers class * implements dev.orcaxr.core.ProjectJsonSink { public void write(byte[]); }
-keepclassmembers class * implements dev.orcaxr.core.LocalTimestampResolver { public long resolve(long); }
