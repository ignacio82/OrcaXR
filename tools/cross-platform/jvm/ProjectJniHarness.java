package dev.orcaxr.core;

import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;

/** Test-only stdin/stdout transport for exercising actual JNI from the same
 * independent Node replay used by WASM. No reflection transport ships in the app. */
public final class ProjectJniHarness {
    public static long actorExportChecks(String source, String canonical, byte[] mesh, byte[] svg, String empty, String large, String largeCanonical) {
        return ProjectActorExportChecks.run(source, canonical, mesh, svg, empty, large, largeCanonical);
    }
    public static long catalogChecks(byte[] catalog, String expected) {
        return ProjectCatalogChecks.run(catalog, expected);
    }
    public static long libraryChecks(byte[] catalog, String expected) {
        return ProjectLibraryChecks.run(catalog, expected);
    }
    public static long actorPreflightChecks(String source, byte[] mesh, String request, String expected) {
        return ProjectPreflightChecks.run(source, mesh, request, expected);
    }
    public static long actorClipboardChecks(String source, String payload, byte[] mesh, byte[] svg) {
        return ProjectActorClipboardChecks.run(source, payload, mesh, svg);
    }
    public static long actorClipboardReplay(String source, String payload, byte[] mesh, byte[] svg, long plate, String expected, long[] effects) {
        return ProjectActorClipboardChecks.replay(source, payload, mesh, svg, plate, expected, effects);
    }
    public static long actorPreparationChecks(String source) { return ProjectActorPreparationChecks.run(source); }
    public static long actorCapturedChecks(String source, String payload, byte[] asset, String expected, long[] effects) {
        return ProjectActorPreparationChecks.captured(source, payload, asset, expected, effects);
    }
    public static long actorChecks(String source) { return ProjectActorChecks.run(source); }
    public static long actorArchiveChecks(String source, byte[] archive, long warnings) {
        return ProjectActorArchiveChecks.run(source, archive, warnings);
    }
    public static long actorImportChecks(String source, byte[] cube, byte[] lossy, byte[] step) {
        return ProjectActorImportChecks.run(source, cube, lossy, step);
    }
    public static long providerDocumentChecks(String source, byte[] archive, long warnings) {
        return ProjectDocumentChecks.run(source, archive, warnings);
    }
    public static String intentCodec(String kind, String input) {
        ProjectIntents codec = ProjectIntents.INSTANCE;
        return switch (kind) {
            case "Intent" -> codec.encodeIntent(codec.decodeIntent(input));
            case "Batch" -> codec.encodeBatch(codec.decodeBatch(input));
            case "SessionRequest" -> codec.encodeSessionRequest(codec.decodeSessionRequest(input));
            case "SessionReply" -> codec.encodeSessionReply(codec.decodeSessionReply(input));
            default -> throw new IllegalArgumentException("unknown test root");
        };
    }
    public static long documentChecks(String source) { return ProjectOwnerChecks.documentChecks(source); }
    public static long clipboardChecks(String source, String payload, byte[] mesh, byte[] svg) {
        return ProjectOwnerChecks.clipboardChecks(source, payload, mesh, svg);
    }
    public static long stagingChecks(String source, String payload) {
        return ProjectOwnerChecks.stagingChecks(source, payload);
    }
    public static String stagedReference(long id, boolean release) {
        return ProjectOwnerChecks.stagedReference(id, release);
    }
    public static String intentLifecycle(int kind, boolean present) {
        return ProjectOwnerChecks.intentLifecycle(kind, present);
    }
    public static String intentNumbers(double[] values, boolean batch) {
        return ProjectOwnerChecks.intentNumbers(values, batch);
    }
    public static double[] queryCodec(double[] input, boolean page) {
        java.util.ArrayList<Double> out = new java.util.ArrayList<>();
        if (page) {
            QueryPage result = ProjectQuery.INSTANCE.decodePage(input);
            out.add((double) ProjectQuery.VERSION); out.add((double) result.getTotal()); out.add((double) result.getStart()); out.add((double) result.getRows().size());
            for (QueryMetadata row : result.getRows()) { out.add((double) (2 + 2 * row.getValues().size())); appendMetadata(out, row); }
        } else appendMetadata(out, ProjectQuery.INSTANCE.decodeMetadata(input));
        return out.stream().mapToDouble(Double::doubleValue).toArray();
    }
    private static void appendMetadata(java.util.ArrayList<Double> out, QueryMetadata row) {
        out.add((double) ProjectQuery.VERSION); out.add((double) row.getKind().ordinal());
        row.getValues().entrySet().stream().sorted(java.util.Comparator.comparingInt(e -> e.getKey().ordinal())).forEach(e -> { out.add((double) e.getKey().ordinal()); out.add(e.getValue()); });
    }
    public static long resolveLocal(String zone, long civil) {
        return new ProjectTimeZone(ZoneId.of(zone)).resolve(civil);
    }
    public static long ownerChecks(String source, String localSource) {
        return ProjectOwnerChecks.run(source, localSource);
    }
    private static final DataInputStream in = new DataInputStream(new BufferedInputStream(System.in));
    private static final DataOutputStream out = new DataOutputStream(new BufferedOutputStream(System.out));
    private static int length() throws IOException {
        int n = in.readInt();
        if (n < 0 || n > 16 * 1024 * 1024) throw new IOException("test input limit");
        return n;
    }
    private static String string() throws IOException {
        byte[] bytes = new byte[length()]; in.readFully(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }
    private static Object argument(Class<?> type) throws IOException {
        if (type == int.class) return in.readInt();
        if (type == long.class) return in.readLong();
        if (type == boolean.class) return in.readBoolean();
        if (type == String.class) {
            // A negative length is a null reference (optional JNI strings).
            int length = in.readInt();
            if (length < 0) return null;
            byte[] bytes = new byte[length]; in.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        }
        if (type == PresetCollator.class) {
            return switch (string()) {
                case "none" -> null;
                case "throw" -> (PresetCollator) (left, right) -> { throw new IllegalStateException("PRIVATE collator detail"); };
                case "reverse" -> (PresetCollator) (left, right) -> java.util.Arrays.compare(right, left);
                default -> (PresetCollator) java.util.Arrays::compare;
            };
        }
        if (type == LocalTimestampResolver.class) {
            String zone = string();
            if (zone.equals("throw")) return (LocalTimestampResolver) value -> { throw new IllegalStateException("PRIVATE timestamp detail"); };
            return new ProjectTimeZone(ZoneId.of(zone));
        }
        if (type == byte[].class) {
            // A negative length is a null reference (optional byte arrays).
            int length = in.readInt();
            if (length < 0) return null;
            if (length > 16 * 1024 * 1024) throw new IOException("test input limit");
            byte[] v = new byte[length]; in.readFully(v); return v;
        }
        int n = length();
        if (type == char[].class) { char[] v = new char[n]; for (int i = 0; i < n; i++) v[i] = in.readChar(); return v; }
        if (type == long[].class) { long[] v = new long[n]; for (int i = 0; i < n; i++) v[i] = in.readLong(); return v; }
        if (type == double[].class) { double[] v = new double[n]; for (int i = 0; i < n; i++) v[i] = in.readDouble(); return v; }
        throw new IOException("unsupported test argument");
    }
    private static void string(String value) throws IOException {
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8); out.writeInt(bytes.length); out.write(bytes);
    }
    private static void value(Object result) throws IOException {
        if (result == null) out.writeByte(0);
        else if (result instanceof Number n) { out.writeByte(1); out.writeLong(n.longValue()); }
        else if (result instanceof Boolean b) { out.writeByte(2); out.writeBoolean(b); }
        else if (result instanceof String s) { out.writeByte(3); string(s); }
        else if (result instanceof byte[] bytes) { out.writeByte(4); out.writeInt(bytes.length); out.write(bytes); }
        else if (result instanceof char[] chars) { out.writeByte(5); out.writeInt(chars.length); for (char c : chars) out.writeChar(c); }
        else if (result instanceof double[] numbers) { out.writeByte(6); out.writeInt(numbers.length); for (double v : numbers) out.writeDouble(v); }
        else throw new IOException("unsupported test result");
    }
    public static void main(String[] args) throws Exception {
        while (true) {
            String name;
            try { name = string(); } catch (EOFException end) { return; }
            Method method = null;
            if (name.equals("actorExportChecks")) method = ProjectJniHarness.class.getMethod(name, String.class, String.class, byte[].class, byte[].class, String.class, String.class, String.class);
            if (name.equals("catalogChecks")) method = ProjectJniHarness.class.getMethod(name, byte[].class, String.class);
            if (name.equals("libraryChecks")) method = ProjectJniHarness.class.getMethod(name, byte[].class, String.class);
            if (name.equals("actorPreflightChecks")) method = ProjectJniHarness.class.getMethod(name, String.class, byte[].class, String.class, String.class);
            if (name.equals("actorClipboardChecks")) method = ProjectJniHarness.class.getMethod(name, String.class, String.class, byte[].class, byte[].class);
            if (name.equals("actorClipboardReplay")) method = ProjectJniHarness.class.getMethod(name, String.class, String.class, byte[].class, byte[].class, long.class, String.class, long[].class);
            if (name.equals("actorPreparationChecks")) method = ProjectJniHarness.class.getMethod(name, String.class);
            if (name.equals("actorCapturedChecks")) method = ProjectJniHarness.class.getMethod(name, String.class, String.class, byte[].class, String.class, long[].class);
            if (name.equals("actorChecks")) method = ProjectJniHarness.class.getMethod(name, String.class);
            if (name.equals("actorArchiveChecks")) method = ProjectJniHarness.class.getMethod(name, String.class, byte[].class, long.class);
            if (name.equals("actorImportChecks")) method = ProjectJniHarness.class.getMethod(name, String.class, byte[].class, byte[].class, byte[].class);
            if (name.equals("providerDocumentChecks")) method = ProjectJniHarness.class.getMethod(name, String.class, byte[].class, long.class);
            if (name.equals("intentCodec")) method = ProjectJniHarness.class.getMethod(name, String.class, String.class);
            if (name.equals("resolveLocal")) method = ProjectJniHarness.class.getMethod(name, String.class, long.class);
            if (name.equals("ownerChecks")) method = ProjectJniHarness.class.getMethod(name, String.class, String.class);
            if (name.equals("stagingChecks")) method = ProjectJniHarness.class.getMethod(name, String.class, String.class);
            if (name.equals("documentChecks")) method = ProjectJniHarness.class.getMethod(name, String.class);
            if (name.equals("clipboardChecks")) method = ProjectJniHarness.class.getMethod(name, String.class, String.class, byte[].class, byte[].class);
            if (name.equals("queryCodec")) method = ProjectJniHarness.class.getMethod(name, double[].class, boolean.class);
            if (name.equals("intentLifecycle")) method = ProjectJniHarness.class.getMethod(name, int.class, boolean.class);
            if (name.equals("stagedReference")) method = ProjectJniHarness.class.getMethod(name, long.class, boolean.class);
            else if (name.equals("intentNumbers")) method = ProjectJniHarness.class.getMethod(name, double[].class, boolean.class);
            for (Method candidate : NativeProject.class.getDeclaredMethods()) {
                if (Modifier.isNative(candidate.getModifiers()) && candidate.getName().equals(name)) method = candidate;
            }
            if (method == null) throw new IOException("unknown test method");
            Class<?>[] types = method.getParameterTypes(); Object[] values = new Object[types.length];
            for (int i = 0; i < types.length; i++) values[i] = argument(types[i]);
            try {
                Object result = method.invoke(null, values);
                out.writeByte(0); value(result);
            } catch (InvocationTargetException failure) {
                if ("1".equals(System.getenv("ORCAXR_JNI_DIAGNOSTICS"))) {
                    StackTraceElement[] frames = failure.getCause().getStackTrace();
                    for (int i = 0; i < Math.min(32, frames.length); i++) System.err.println(frames[i]);
                }
                out.writeByte(1); string(String.valueOf(failure.getCause().getMessage()));
            }
            out.flush();
        }
    }
}
