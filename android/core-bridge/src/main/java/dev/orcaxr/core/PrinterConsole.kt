package dev.orcaxr.core

/** Typing G-code at a machine that can hurt itself (`orcaxr_printer::console`),
 * as the browser's `PrinterConsole` answers it: a script assessed (the command
 * Klipper runs for each line, its risk, and the running job's part in it);
 * the request a send or macro listing sends, or why it is refused before
 * anything leaves; the result an exchange that ended without a reply reads
 * as; the printer's macros read from its configuration; a macro invocation
 * spelled so Klipper reads its values back exactly, or refused; and
 * transcript lines redacted on the way in, classified and recalled. The host
 * carries each exchange out and keeps the bounded transcript. */
object PrinterConsole {
    fun assess(request: ProjectIntents.GcodeAssessRequest): ProjectIntents.GcodeAssessment =
        ProjectIntents.decodeGcodeAssessment(NativeProject.consoleAssess(ProjectIntents.encodeGcodeAssessRequest(request)))
    fun plan(operation: ProjectIntents.ConsoleOperation): ProjectIntents.ConsolePlan =
        ProjectIntents.decodeConsolePlan(NativeProject.consolePlan(ProjectIntents.encodeConsoleOperation(operation)))
    fun finish(request: ProjectIntents.ConsoleFinish): ProjectIntents.ConsoleResult =
        ProjectIntents.decodeConsoleResult(NativeProject.consoleFinish(ProjectIntents.encodeConsoleFinish(request)))
    /** [reply] is Moonraker's `result`, as JSON. */
    fun read(operation: ProjectIntents.ConsoleOperation, reply: String): ProjectIntents.ConsoleResult =
        ProjectIntents.decodeConsoleResult(NativeProject.consoleRead(ProjectIntents.encodeConsoleOperation(operation), reply))
    fun invocation(request: ProjectIntents.MacroInvocationRequest): ProjectIntents.MacroInvocation =
        ProjectIntents.decodeMacroInvocation(NativeProject.consoleInvocation(ProjectIntents.encodeMacroInvocationRequest(request)))
    fun line(request: ProjectIntents.ConsoleLineRequest): ProjectIntents.ConsoleLine =
        ProjectIntents.decodeConsoleLine(NativeProject.consoleLine(ProjectIntents.encodeConsoleLineRequest(request)))
    /** [params] is the notification's params, as JSON. */
    fun notification(request: ProjectIntents.ConsoleNotificationRequest, params: String): ProjectIntents.OptionalConsoleLine =
        ProjectIntents.decodeOptionalConsoleLine(NativeProject.consoleNotification(ProjectIntents.encodeConsoleNotificationRequest(request), params))
    fun recent(request: ProjectIntents.ConsoleRecentRequest): List<List<Int>> =
        ProjectIntents.decodeTextList(NativeProject.consoleRecent(ProjectIntents.encodeConsoleRecentRequest(request)))
}
